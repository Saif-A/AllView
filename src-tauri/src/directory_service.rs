//! On-demand directory totals. No source writes, link traversal, persistent index or unbounded work.
use serde::Serialize;
use std::{fs,path::{Path,PathBuf},sync::atomic::{AtomicU64,Ordering},time::{Instant,Duration}};
pub const MAX_ENTRIES:usize=50_000;
const MAX_DEPTH:usize=48;
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Node {pub token:usize,pub parent:Option<usize>,pub name:String,pub directory:bool,pub bytes:u64,pub files:u64,pub folders:u64,pub partial:bool,pub issue:Option<String>}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Report {pub root:String,pub nodes:Vec<Node>,pub elapsed_ms:u128,pub partial:bool}
pub struct Snapshot {pub report:Report,paths:Vec<PathBuf>,root:PathBuf}
fn linked(meta:&fs::Metadata)->bool {
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;meta.file_attributes()&0x400!=0}
    #[cfg(not(windows))] {meta.file_type().is_symlink()}
}
impl Snapshot {
    pub fn path(&self,token:usize)->Result<PathBuf,String> {
        let path=self.paths.get(token).ok_or("This folder item is no longer available.")?;
        // Recheck every component: a scanned subdirectory can be replaced by a link.
        let relative=path.strip_prefix(&self.root).map_err(|_|"Folder item is outside the selected root.")?;
        let mut checked=self.root.clone();
        if linked(&fs::symlink_metadata(&checked).map_err(|e|e.to_string())?){return Err("Linked folders are not traversed.".into())}
        for component in relative.components(){checked.push(component);if linked(&fs::symlink_metadata(&checked).map_err(|e|e.to_string())?){return Err("This item changed to a link. Scan again.".into())}}
        let canonical=fs::canonicalize(path).map_err(|e|e.to_string())?;
        let root=fs::canonicalize(&self.root).map_err(|e|e.to_string())?;
        if !canonical.starts_with(root){return Err("Folder item moved outside the selected root.".into())}Ok(path.clone())
    }
}
pub fn scan(root:&Path,generation:&AtomicU64,expected:u64,progress:impl Fn(usize))->Result<Snapshot,String> {
    let root=std::path::absolute(root).map_err(|e|e.to_string())?;
    let meta=fs::symlink_metadata(&root).map_err(|e|e.to_string())?;
    if !meta.is_dir()||linked(&meta){return Err("Select an ordinary folder; linked folders are not scanned.".into())}
    let start=Instant::now();let mut nodes=Vec::new();let mut paths=Vec::new();
    fn visit(path:PathBuf,parent:Option<usize>,depth:usize,nodes:&mut Vec<Node>,paths:&mut Vec<PathBuf>,start:Instant,generation:&AtomicU64,expected:u64,progress:&impl Fn(usize))->Result<usize,String>{
        if generation.load(Ordering::Relaxed)!=expected{return Err("Folder scan cancelled.".into())}
        let token=nodes.len();let meta=fs::symlink_metadata(&path);
        let name=path.file_name().map(|n|n.to_string_lossy().into_owned()).unwrap_or_else(||path.display().to_string());
        let (directory,bytes,files,partial,issue)=match &meta {
            Ok(m) if linked(m)=>(false,0,0,true,Some("Link/reparse point skipped".into())),
            Ok(m)=>(m.is_dir(),if m.is_file(){m.len()}else{0},if m.is_file(){1}else{0},false,None),
            Err(e)=>(false,0,0,true,Some(e.to_string())),
        };
        nodes.push(Node{token,parent,name,directory,bytes,files,folders:0,partial,issue});paths.push(path.clone());
        if token%250==0{progress(token+1)}
        if directory {
            if depth>=MAX_DEPTH {nodes[token].partial=true;nodes[token].issue=Some("Depth limit reached".into());return Ok(token)}
            let entries=match fs::read_dir(&path){Ok(entries)=>entries,Err(e)=>{nodes[token].partial=true;nodes[token].issue=Some(e.to_string());return Ok(token)}};
            for entry in entries {
                if generation.load(Ordering::Relaxed)!=expected{return Err("Folder scan cancelled.".into())}
                if nodes.len()>=MAX_ENTRIES||start.elapsed()>Duration::from_secs(15){nodes[token].partial=true;nodes[token].issue=Some("Entry/time limit reached; totals are partial".into());break}
                let entry=match entry{Ok(e)=>e,Err(e)=>{nodes[token].partial=true;nodes[token].issue=Some(e.to_string());continue}};
                let child=visit(entry.path(),Some(token),depth+1,nodes,paths,start,generation,expected,progress)?;
                nodes[token].bytes=nodes[token].bytes.saturating_add(nodes[child].bytes);nodes[token].files=nodes[token].files.saturating_add(nodes[child].files);
                nodes[token].folders=nodes[token].folders.saturating_add(nodes[child].folders+u64::from(nodes[child].directory));nodes[token].partial|=nodes[child].partial;
            }
        }Ok(token)
    }
    visit(root.clone(),None,0,&mut nodes,&mut paths,start,generation,expected,&progress)?;
    let partial=nodes[0].partial;let report=Report{root:root.display().to_string(),nodes,elapsed_ms:start.elapsed().as_millis(),partial};Ok(Snapshot{report,paths,root})
}
#[cfg(test)] mod tests {
    use super::*;
    fn fixture()->PathBuf {let p=std::env::temp_dir().join(format!("av-directory-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(p.join("nested")).unwrap();fs::write(p.join("a.txt"),b"123").unwrap();fs::write(p.join("nested/b.txt"),b"12345").unwrap();p}
    #[test]fn totals_and_tokens_follow_the_selected_root(){let p=fixture();let scan=scan(&p,&AtomicU64::new(1),1,|_|{}).unwrap();assert_eq!(scan.report.nodes[0].bytes,8);assert_eq!(scan.report.nodes[0].files,2);assert_eq!(scan.report.nodes[0].folders,1);for i in 0..scan.report.nodes.len(){assert!(scan.path(i).unwrap().starts_with(&p))}assert!(scan.path(999).is_err());assert_eq!(fs::read(p.join("a.txt")).unwrap(),b"123");}
    #[test]fn obsolete_scan_cancels(){assert!(scan(&fixture(),&AtomicU64::new(2),1,|_|{}).err().unwrap().contains("cancelled"));}
}
