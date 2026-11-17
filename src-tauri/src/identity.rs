//! One-time directory migration before WebView2 or the OCR cache opens files.
use std::{path::Path,fs};
fn relocate(parent:&Path,old:&str,new:&str)->Result<(),String>{
 let from=parent.join(old);let to=parent.join(new);
 if !from.exists()||to.exists(){return Ok(())}
 let metadata=fs::symlink_metadata(&from).map_err(|e|e.to_string())?;
 use std::os::windows::fs::MetadataExt;
 if !metadata.is_dir()||metadata.file_attributes()&0x400!=0{return Err("Identity migration will not traverse linked app data.".into())}
 fs::rename(from,to).map_err(|e|e.to_string())
}
pub fn migrate(){
 for name in ["LOCALAPPDATA","APPDATA"]{if let Some(root)=std::env::var_os(name){if let Err(error)=relocate(Path::new(&root),"app.quickviewplusplus.viewer","app.allview.viewer"){eprintln!("App profile migration deferred: {error}")}}}
 // The native Known Folder lookup respects redirected Pictures directories.
 extern "C"{fn av_capture_home(buffer:*mut u16,size:i32)->bool;}
 let mut buffer=vec![0u16;32768];if unsafe{av_capture_home(buffer.as_mut_ptr(),buffer.len() as i32)}{let len=buffer.iter().position(|v|*v==0).unwrap_or(0);if len>0{let root=std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..len]));if let Err(error)=relocate(&root,"quickview++","All View"){eprintln!("Capture folder migration deferred: {error}")}}}
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn directory_migration_preserves_bytes_and_an_existing_destination(){
  let root=std::env::temp_dir().join(format!("allview-identity-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(root.join("old")).unwrap();fs::write(root.join("old/choice"),b"saved").unwrap();relocate(&root,"old","new").unwrap();assert_eq!(fs::read(root.join("new/choice")).unwrap(),b"saved");assert!(!root.join("old").exists());fs::create_dir(root.join("old")).unwrap();fs::write(root.join("old/choice"),b"other").unwrap();relocate(&root,"old","new").unwrap();assert_eq!(fs::read(root.join("new/choice")).unwrap(),b"saved");assert_eq!(fs::read(root.join("old/choice")).unwrap(),b"other");fs::remove_dir_all(root).unwrap();
 }
}
