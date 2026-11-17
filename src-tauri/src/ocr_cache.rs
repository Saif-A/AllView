//! Optional, current-preview-owned OCR cache. Source bytes/paths never reach disk here.
use std::{fs,io::Write,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH},sync::{OnceLock,atomic::{AtomicU64,Ordering}}};
use std::os::windows::fs::MetadataExt;
use serde::{Deserialize,Serialize};use sha2::{Digest,Sha256};
const PROFILE:&str="ocr-v2:psm3-auto-200dpi-4mp-3200:pdf-quads-utf16";
fn default_profile()->&'static str{static VALUE:OnceLock<String>=OnceLock::new();VALUE.get_or_init(||{let manifest:serde_json::Value=serde_json::from_str(include_str!("../../package.json")).expect("valid pinned dependency manifest");let deps=&manifest["dependencies"];format!("{PROFILE}:{}:{}:{}:{}",deps["tesseract.js"],deps["@tesseract.js-data/ara"],deps["@tesseract.js-data/eng"],deps["pdfjs-dist"])})}
const IDLE:u64=30*24*60*60;const PAGE_MAX:u64=4*1024*1024;const DOC_MAX:u64=32*1024*1024;const TOTAL_MAX:u64=256*1024*1024;const DOCS:usize=256;const PAGES:u32=5000;
fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}
fn error(_:impl std::fmt::Display)->String{"OCR cache is unavailable; recognition remains available.".into()}
fn plain(path:&Path)->Result<fs::Metadata,String>{let m=fs::symlink_metadata(path).map_err(error)?;if m.file_attributes()&0x400!=0||m.file_type().is_symlink(){return Err("OCR cache links are not allowed.".into())}Ok(m)}
fn directory(path:&Path)->Result<(),String>{for parent in path.ancestors(){if parent.exists(){plain(parent)?;}}fs::create_dir_all(path).map_err(error)?;if !plain(path)?.is_dir(){return Err("Invalid OCR cache directory.".into())}Ok(())}
fn page_name(page:u32)->String{format!("p-{page:05}.json")}
fn page_number(name:&str)->Option<u32>{let value=name.strip_prefix("p-")?.strip_suffix(".json")?.parse::<u32>().ok()?;(value>0&&value<=PAGES&&name==page_name(value)).then_some(value)}
fn hash_name(name:&str)->bool{name.len()==64&&name.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn atomic(path:&Path,bytes:&[u8])->Result<(),String>{
 static SERIAL:AtomicU64=AtomicU64::new(1);let parent=path.parent().ok_or("Invalid cache path.")?;directory(parent)?;
 if path.exists()&&!plain(path)?.is_file(){return Err("Invalid cache file.".into())}
 let temp=parent.join(format!(".tmp-{}-{}-{}",std::process::id(),now(),SERIAL.fetch_add(1,Ordering::Relaxed)));
 let result=(||{let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(error)?;file.write_all(bytes).map_err(error)?;drop(file);fs::rename(&temp,path).map_err(error)})();if result.is_err(){let _=fs::remove_file(temp);}result
}
#[derive(Clone,Debug,Deserialize,Serialize)]#[serde(deny_unknown_fields)]
pub struct WordBox{pub from:usize,pub to:usize,pub quad:[f64;8],#[serde(default,skip_serializing_if="Option::is_none")]pub rtl:Option<bool>}
#[derive(Clone,Debug,Deserialize,Serialize)]#[serde(deny_unknown_fields)]
pub struct Page{pub page:u32,pub text:String,pub boxes:Vec<WordBox>,#[serde(default,skip_serializing_if="Option::is_none")]pub native:Option<NativePage>,#[serde(default,skip_serializing_if="Option::is_none")]pub ocr:Option<bool>}
#[derive(Clone,Debug,Deserialize,Serialize)]#[serde(deny_unknown_fields)]
pub struct NativePage{pub text:String,pub boxes:Vec<WordBox>,pub scanned:bool}
fn valid_text(text:&str,boxes:&[WordBox])->bool{let length=text.encode_utf16().count();text.len()<=1024*1024&&boxes.len()<=20000&&boxes.iter().all(|b|b.from<b.to&&b.to<=length&&b.quad.iter().all(|n|n.is_finite()&&n.abs()<=10_000_000.))}
impl Page{fn valid(&self)->bool{self.page>0&&self.page<=PAGES&&valid_text(&self.text,&self.boxes)&&self.native.as_ref().is_none_or(|n|valid_text(&n.text,&n.boxes))}}
#[derive(Deserialize,Serialize)]#[serde(deny_unknown_fields)]
struct Metadata{schema:u32,key:String,last_used:u64,bytes:u64,#[serde(default,skip_serializing_if="Option::is_none")]source:Option<String>}
fn metadata(path:&Path)->Option<Metadata>{let file=path.join("document.json");let m=plain(&file).ok()?;if !m.is_file()||m.len()>4096{return None}let value:Metadata=serde_json::from_slice(&fs::read(file).ok()?).ok()?;(value.schema==1&&value.bytes<=DOC_MAX&&hash_name(&value.key)&&path.file_name()?.to_str()?==value.key).then_some(value)}
fn remove_expired(path:&Path,budget:&mut usize)->bool{
 // Validate the whole flat unit first; never follow or recursively delete links/user additions.
 let Ok(entries)=fs::read_dir(path)else{return false};let mut files=Vec::new();
 for entry in entries.take(PAGES as usize+4){let Ok(entry)=entry else{return false};let name=entry.file_name();let Some(name)=name.to_str()else{return false};if name!="document.json"&&page_number(name).is_none()&&!name.starts_with(".tmp-"){return false}let Ok(m)=plain(&entry.path())else{return false};if !m.is_file(){return false}files.push(entry.path())}
 if files.len()>PAGES as usize+2||files.len()>*budget{return false}*budget-=files.len();
 for file in files{if fs::remove_file(file).is_err(){return false}}fs::remove_dir(path).is_ok()
}
fn sweep(root:&Path,time:u64,priority:Option<&str>)->Result<(usize,u64),String>{
 directory(root)?;let mut count=0;let mut bytes=0;let mut budget=6000;
 if let Some(key)=priority{let path=root.join(key);if plain(&path).is_ok_and(|m|m.is_dir())&&metadata(&path).is_some_and(|m|time.saturating_sub(m.last_used)>=IDLE){remove_expired(&path,&mut budget);}}
 for entry in fs::read_dir(root).map_err(error)?.take(DOCS+1){let entry=entry.map_err(error)?;let name=entry.file_name();if !name.to_str().is_some_and(hash_name){continue}let path=entry.path();let Ok(m)=plain(&path)else{continue};if !m.is_dir(){continue}let Some(meta)=metadata(&path)else{continue};if time.saturating_sub(meta.last_used)>=IDLE&&budget>0&&remove_expired(&path,&mut budget){continue}count+=1;bytes+=meta.bytes;}
 Ok((count,bytes))
}
pub struct Session{owner:u64,key:String,root:PathBuf,bytes:u64,all_bytes:u64,initialized:bool,source:Option<String>}
impl Session{
 pub fn hasher()->Sha256{let mut hash=Sha256::new();hash.update(default_profile().as_bytes());hash.update([0]);hash}
 pub fn cached_digest(root:&Path,source:&str)->Option<String>{if !hash_name(source)||!plain(root).ok()?.is_dir(){return None}for entry in fs::read_dir(root).ok()?.take(DOCS+1).flatten(){if !plain(&entry.path()).is_ok_and(|m|m.is_dir()){continue}if let Some(meta)=metadata(&entry.path()){if meta.source.as_deref()==Some(source)&&now().saturating_sub(meta.last_used)<IDLE{return Some(meta.key)}}}None}
 pub fn from_digest(owner:u64,key:String,root:PathBuf,source:String)->Self{Self{owner,key,root,bytes:0,all_bytes:0,initialized:false,source:Some(source)}}
 pub fn new(owner:u64,bytes:&[u8],root:PathBuf)->Self{Self::profile(owner,bytes,root,default_profile())}
 pub fn image(owner:u64,bytes:&[u8],root:PathBuf)->Self{Self::profile(owner,bytes,root,&format!("{}:image-v1-native-pixels-4mp-3200-unit-quads",default_profile()))}
 fn profile(owner:u64,bytes:&[u8],root:PathBuf,profile:&str)->Self{let mut hash=Sha256::new();hash.update(profile.as_bytes());hash.update([0]);hash.update(bytes);Self{owner,key:format!("{:x}",hash.finalize()),root,bytes:0,all_bytes:0,initialized:false,source:None}}
 fn check(&self,owner:u64)->Result<(),String>{if self.owner!=owner{Err("Preview cancelled.".into())}else{Ok(())}}
 fn touch(&self,time:u64)->Result<(),String>{atomic(&self.root.join(&self.key).join("document.json"),&serde_json::to_vec(&Metadata{schema:1,key:self.key.clone(),last_used:time,bytes:self.bytes,source:self.source.clone()}).map_err(error)?)}
 pub fn used(&self,owner:u64)->Result<(),String>{self.used_at(owner,now())}
 fn used_at(&self,owner:u64,time:u64)->Result<(),String>{self.check(owner)?;if self.initialized&&self.bytes>0&&metadata(&self.root.join(&self.key)).is_some(){self.touch(time)}else{Ok(())}}
 pub fn load(&mut self,owner:u64)->Result<Vec<Page>,String>{self.load_at(owner,now())}
 fn load_at(&mut self,owner:u64,time:u64)->Result<Vec<Page>,String>{
  self.check(owner)?;let (count,total)=sweep(&self.root,time,Some(&self.key))?;let dir=self.root.join(&self.key);if metadata(&dir).is_some_and(|m|time.saturating_sub(m.last_used)>=IDLE){return Err("Expired OCR cache contains protected entries.".into())}if !dir.exists(){if count>=DOCS||total>=TOTAL_MAX{return Err("OCR cache storage limit reached.".into())}self.bytes=0;self.all_bytes=total;self.initialized=true;return Ok(Vec::new())}directory(&dir)?;let mut pages=Vec::new();let mut bytes=0;
  for entry in fs::read_dir(&dir).map_err(error)?.take(PAGES as usize+3){let entry=entry.map_err(error)?;let name=entry.file_name();let Some(name)=name.to_str()else{continue};if page_number(name).is_none(){continue}let m=plain(&entry.path())?;if !m.is_file(){return Err("Invalid OCR cache entry.".into())}bytes+=m.len();if bytes>DOC_MAX{return Err("OCR cache document limit reached.".into())}if m.len()>PAGE_MAX{continue}if let Ok(page)=fs::read(entry.path()).map_err(error).and_then(|bytes|serde_json::from_slice::<Page>(&bytes).map_err(error)){if page.valid()&&name==page_name(page.page){pages.push(page)}}
  }
  let previous=metadata(&dir).map(|m|m.bytes).unwrap_or(0);self.bytes=bytes;self.all_bytes=total.saturating_sub(previous)+bytes;self.initialized=true;self.touch(time)?;pages.sort_unstable_by_key(|p|p.page);Ok(pages)
 }
 pub fn save(&mut self,owner:u64,body:&[u8])->Result<(),String>{self.save_at(owner,body,now())}
 fn save_at(&mut self,owner:u64,body:&[u8],time:u64)->Result<(),String>{
  self.check(owner)?;if !self.initialized||body.len() as u64>PAGE_MAX{return Err("OCR cache page limit reached.".into())}let mut page:Page=serde_json::from_slice(body).map_err(error)?;if !page.valid(){return Err("Invalid OCR cache page.".into())}
  let dir=self.root.join(&self.key);directory(&dir)?;let path=dir.join(page_name(page.page));let old=if path.exists(){let m=plain(&path)?;if !m.is_file(){return Err("Invalid OCR cache entry.".into())}m.len()}else{0};let size=body.len() as u64;let next=self.bytes.saturating_sub(old)+size;let total=self.all_bytes.saturating_sub(old)+size;if next>DOC_MAX||total>TOTAL_MAX{return Err("OCR cache storage limit reached.".into())}
  if old>0&&old<=PAGE_MAX{if let Ok(bytes)=fs::read(&path){if let Ok(previous)=serde_json::from_slice::<Page>(&bytes){if previous.valid(){if page.ocr==Some(false)&&previous.ocr!=Some(false){page.text=previous.text;page.boxes=previous.boxes;page.ocr=previous.ocr}if page.native.is_none(){page.native=previous.native}}}}}
  let body=serde_json::to_vec(&page).map_err(error)?;let size=body.len() as u64;let next=self.bytes.saturating_sub(old)+size;let total=self.all_bytes.saturating_sub(old)+size;if size>PAGE_MAX||next>DOC_MAX||total>TOTAL_MAX{return Err("OCR cache storage limit reached.".into())}
  atomic(&path,&body)?;self.bytes=next;self.all_bytes=total;self.touch(time)
 }
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn native_index_merges_with_ocr_and_file_identity_reuses_only_live_entries(){let f=Fixture::new();let mut hash=Session::hasher();hash.update(b"pdf");let key=format!("{:x}",hash.finalize());assert_eq!(key,Session::new(1,b"pdf",f.0.clone()).key);let source="a".repeat(64);let mut s=Session::from_digest(1,key.clone(),f.0.clone(),source.clone());s.load(1).unwrap();s.save(1,&body()).unwrap();let native=serde_json::json!({"page":1,"text":"","boxes":[],"ocr":false,"native":{"text":"native needle","boxes":[],"scanned":true}});s.save(1,&serde_json::to_vec(&native).unwrap()).unwrap();let page=s.load(1).unwrap().remove(0);assert_eq!(page.text,"العربية");assert_eq!(page.native.unwrap().text,"native needle");s.save(1,&body()).unwrap();assert!(s.load(1).unwrap()[0].native.is_some());assert_eq!(Session::cached_digest(&f.0,&source),Some(key));assert!(Session::cached_digest(&f.0,&"b".repeat(64)).is_none());s.touch(now()-IDLE-1).unwrap();assert!(Session::cached_digest(&f.0,&source).is_none());}
 struct Fixture(PathBuf);impl Fixture{fn new()->Self{static NEXT:AtomicU64=AtomicU64::new(1);let p=std::env::temp_dir().join(format!("av-ocr-cache-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));fs::create_dir_all(&p).unwrap();Self(p)}}impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
 fn body()->Vec<u8>{serde_json::to_vec(&Page{native:None,ocr:None,page:1,text:"العربية".into(),boxes:vec![WordBox{from:0,to:7,quad:[0.,10.,70.,10.,70.,0.,0.,0.],rtl:Some(true)}]}).unwrap()}
 #[test]fn image_cache_reopens_but_never_reuses_pdf_coordinates(){let f=Fixture::new();let mut s=Session::image(1,b"image",f.0.clone());s.load(1).unwrap();let page=Page{native:None,ocr:None,page:1,text:"image text".into(),boxes:vec![WordBox{from:0,to:5,quad:[0.1,0.1,0.3,0.1,0.3,0.2,0.1,0.2],rtl:None}]};s.save(1,&serde_json::to_vec(&page).unwrap()).unwrap();assert_eq!(Session::image(2,b"image",f.0.clone()).load(2).unwrap()[0].text,"image text");assert!(Session::new(3,b"image",f.0.clone()).load(3).unwrap().is_empty());assert!(Session::image(4,b"changed image",f.0.clone()).load(4).unwrap().is_empty());assert!(s.load(2).is_err());}
 #[test]fn an_unused_cache_miss_does_not_allocate_a_document_slot(){let f=Fixture::new();let mut s=Session::new(1,b"%PDF-native-text",f.0.clone());assert!(s.load(1).unwrap().is_empty());assert_eq!(fs::read_dir(&f.0).unwrap().count(),0);s.save(1,&body()).unwrap();assert_eq!(fs::read_dir(&f.0).unwrap().count(),1);}
 #[test]fn disk_reopen_reuses_words_and_content_or_profile_changes_miss(){let f=Fixture::new();let mut first=Session::new(1,b"%PDF-original",f.0.clone());assert!(first.load_at(1,100).unwrap().is_empty());first.save_at(1,&body(),100).unwrap();let mut second=Session::new(2,b"%PDF-original",f.0.clone());assert_eq!(second.load_at(2,101).unwrap()[0].text,"العربية");assert!(Session::new(3,b"%PDF-changed",f.0.clone()).load_at(3,102).unwrap().is_empty());assert!(Session::profile(4,b"%PDF-original",f.0.clone(),"new-engine-profile").load_at(4,102).unwrap().is_empty());}
 #[test]fn cached_use_renews_idle_expiry_and_expired_units_are_removed(){let f=Fixture::new();let mut s=Session::new(1,b"%PDF",f.0.clone());s.load_at(1,100).unwrap();s.save_at(1,&body(),100).unwrap();s.used_at(1,100+IDLE-1).unwrap();assert!(s.used_at(2,100+IDLE).is_err());assert_eq!(Session::new(3,b"%PDF",f.0.clone()).load_at(3,100+IDLE+1).unwrap().len(),1);let mut later=Session::new(4,b"%PDF",f.0.clone());assert!(later.load_at(4,100+2*IDLE+2).unwrap().is_empty());}
 #[test]fn stale_invalid_and_corrupt_cache_never_become_results(){let f=Fixture::new();let mut s=Session::new(1,b"%PDF",f.0.clone());s.load(1).unwrap();assert!(s.save(2,&body()).is_err());assert!(s.load(2).is_err());assert!(s.save(1,br#"{"page":5001,"text":"x","boxes":[]}"#).is_err());assert!(s.save(1,br#"{"page":1,"text":"x","boxes":[{"from":0,"to":10,"quad":[0,0,0,0,0,0,0,0]}]}"#).is_err());s.save(1,&body()).unwrap();fs::write(f.0.join(&s.key).join(page_name(1)),b"broken").unwrap();assert!(Session::new(2,b"%PDF",f.0.clone()).load(2).unwrap().is_empty());}
 #[test]fn expiry_preserves_unknown_entries_and_quota_rejects_new_payload(){let f=Fixture::new();let mut s=Session::new(1,b"%PDF",f.0.clone());s.load_at(1,1).unwrap();s.save_at(1,&body(),1).unwrap();let note=f.0.join(&s.key).join("user-note.txt");fs::write(&note,b"preserve").unwrap();sweep(&f.0,IDLE+2,None).unwrap();assert_eq!(fs::read(&note).unwrap(),b"preserve");assert!(Session::new(2,b"%PDF",f.0.clone()).load_at(2,IDLE+2).is_err());s.all_bytes=TOTAL_MAX;let mut page:Page=serde_json::from_slice(&body()).unwrap();page.text.push('x');assert!(s.save_at(1,&serde_json::to_vec(&page).unwrap(),IDLE+2).is_err());assert!(s.save_at(1,&vec![0;PAGE_MAX as usize+1],IDLE+2).is_err());}
}
