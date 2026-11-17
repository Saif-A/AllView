//! Lazy in-process editor. Borrowed ABI pointers live through the synchronous STA session.
use std::{ffi::c_void,path::Path,panic::{catch_unwind,AssertUnwindSafe}};
use serde_json::{Value,json};
const MAX_HEADER:usize=16*1024;
const MAX_IMAGE:usize=64*1024*1024;
pub fn restore_after_error(error:Option<&str>)->bool{!matches!(error,Some(value) if value==crate::capture_service::FOCUS_CANCEL)}
type Callback=unsafe extern "C" fn(*mut c_void,*const u8,i32,*const u8,i32,*mut u8,i32)->i32;
#[repr(C)]
struct Request {version:i32,header_len:i32,header:*const u8,image_len:i32,image:*const u8,context:*mut c_void,send:Callback}
extern "C"{fn av_editor_run(directory:*const u16,request:*mut c_void,size:i32,error:*mut u8,capacity:i32)->i32;}
struct Session<'a>{check:&'a(dyn Fn()->Result<(),String>+Sync),output:&'a mut(dyn FnMut(&str,&str,&[u8])->Result<Value,String>+Send),captured:Option<Vec<u8>>,error:Option<String>}
impl Session<'_>{
 fn handle(&mut self,header:Value,bytes:&[u8])->Result<Value,String>{
  if header["action"]!="error" {if let Err(error)=(self.check)(){self.error=Some(error.clone());return Err(error)}}
  match header["action"].as_str(){
   Some("ready"|"check"|"closed")=>Ok(json!({"ok":true})),
   Some("cancelled")=>{if header["focusChanged"]==true{self.error=Some(crate::capture_service::FOCUS_CANCEL.into())}Ok(json!({"ok":true}))},
   Some("captured")=>{if let Err(error)=crate::image_export::validate(bytes,"png"){self.error=Some(error.clone());return Err(error)}self.captured=Some(bytes.to_vec());Ok(json!({"ok":true}))},
   Some("error")=>{self.error=Some(header["error"].as_str().unwrap_or("Image editor failed.").to_string());Ok(json!({"ok":true}))},
   Some(action @ ("save"|"save-as"|"copy"))=>{let format=header["format"].as_str().unwrap_or("");crate::image_export::validate(bytes,format)?;(self.output)(action,format,bytes)},
   _=>Err("Unknown image editor request.".into())
  }
 }
}
fn decode_header<'a>(header:&[u8],bytes:&'a[u8])->Result<(Value,&'a[u8]),String>{
 if !(2..=MAX_HEADER).contains(&header.len())||bytes.len()>MAX_IMAGE{return Err("Editor message exceeds its limit.".into())}
 Ok((serde_json::from_slice(header).map_err(|_|"Invalid editor message.")?,bytes))
}
unsafe extern "C" fn callback(context:*mut c_void,header:*const u8,header_len:i32,image:*const u8,image_len:i32,reply:*mut u8,capacity:i32)->i32{
 if context.is_null()||header.is_null()||reply.is_null()||!(2..=MAX_HEADER as i32).contains(&header_len)||!(0..=MAX_IMAGE as i32).contains(&image_len)||image_len>0&&image.is_null()||capacity<2||capacity>MAX_HEADER as i32{return -1}
 let result=catch_unwind(AssertUnwindSafe(||{
  let session=&mut *(context as *mut Session<'_>);
  let bytes=if image_len==0{&[]}else{std::slice::from_raw_parts(image,image_len as usize)};
  decode_header(std::slice::from_raw_parts(header,header_len as usize),bytes).and_then(|(h,b)|session.handle(h,b))
 }));
 let value=match result{Ok(Ok(value))=>value,Ok(Err(error))=>json!({"ok":false,"error":error}),Err(_)=>json!({"ok":false,"error":"Editor operation failed."})};
 let encoded=serde_json::to_vec(&value).unwrap_or_default();if encoded.len()>capacity as usize{return -1}
 std::ptr::copy_nonoverlapping(encoded.as_ptr(),reply,encoded.len());encoded.len() as i32
}
fn invoke(directory:&Path,header:&[u8],image:&[u8],context:*mut c_void,send:Callback)->Result<(),String>{
 if !(2..=MAX_HEADER).contains(&header.len())||image.len()>MAX_IMAGE{return Err("Editor input exceeds its limit.".into())}
 let directory:Vec<u16>=directory.as_os_str().encode_wide().chain(Some(0)).collect();
 let mut request=Request{version:1,header_len:header.len() as i32,header:header.as_ptr(),image_len:image.len() as i32,image:image.as_ptr(),context,send};
 let mut error=[0u8;1024];let result=unsafe{av_editor_run(directory.as_ptr(),&mut request as *mut _ as *mut c_void,std::mem::size_of::<Request>() as i32,error.as_mut_ptr(),error.len() as i32)};
 if result!=0{let n=error.iter().position(|b|*b==0).unwrap_or(error.len());return Err(if n>0{String::from_utf8_lossy(&error[..n]).into_owned()}else{format!("The All View editor rejected this session ({result}).")})}Ok(())
}
use std::os::windows::ffi::OsStrExt;
fn run(header:Value,bytes:&[u8],check:&(dyn Fn()->Result<(),String>+Sync),output:&mut(dyn FnMut(&str,&str,&[u8])->Result<Value,String>+Send))->Result<Option<Vec<u8>>,String>{
 let directory=std::env::current_exe().map_err(|e|e.to_string())?.parent().ok_or("Viewer location unavailable.")?.join("editor");
 let mut session=Session{check,output,captured:None,error:None};let json=serde_json::to_vec(&header).map_err(|e|e.to_string())?;
 invoke(&directory,&json,bytes,&mut session as *mut _ as *mut c_void,callback)?;
 if let Some(error)=session.error{return Err(error)}Ok(session.captured)
}
pub fn capture()->Result<Option<Vec<u8>>,String>{run(json!({"mode":"capture"}),&[],&||Ok(()),&mut|_,_,_|Err("Output is unavailable during capture.".into()))}
pub fn edit(header:Value,bytes:&[u8],check:impl Fn()->Result<(),String>+Sync,mut output:impl FnMut(&str,&str,&[u8])->Result<Value,String>+Send)->Result<(),String>{run(header,bytes,&check,&mut output).map(|_|())}
/// Exercise the real hidden editor/ABI without capture, clipboard, save or print.
pub fn verify_store_runtime()->Result<Value,String>{
 let directory=std::env::current_exe().map_err(|e|e.to_string())?.parent().ok_or("Viewer location unavailable.")?.join("editor");
 let mut records=Vec::<Value>::new();
 unsafe extern "C" fn receive(context:*mut c_void,h:*const u8,n:i32,_:*const u8,b:i32,r:*mut u8,c:i32)->i32{
  if context.is_null()||h.is_null()||r.is_null()||b!=0||c<11||!(2..=MAX_HEADER as i32).contains(&n){return -1}
  let Ok(value)=serde_json::from_slice::<Value>(std::slice::from_raw_parts(h,n as usize))else{return -1};
  let allowed=matches!(value["action"].as_str(),Some("ready"|"check"|"fixture"|"closed"|"error"));
  (&mut *(context as *mut Vec<Value>)).push(value);let reply=if allowed{b"{\"ok\":true}".as_slice()}else{b"{\"ok\":false}".as_slice()};
  if reply.len()>c as usize{return -1}std::ptr::copy_nonoverlapping(reply.as_ptr(),r,reply.len());reply.len() as i32
 }
 for _ in 0..3{invoke(&directory,br#"{"mode":"self-test"}"#,&[],&mut records as *mut _ as *mut c_void,receive)?;}
 let fixtures:Vec<_>=records.iter().filter(|v|v["action"]=="fixture").collect();
 if fixtures.len()!=3||fixtures.iter().any(|v|v["pid"].as_u64()!=Some(std::process::id() as u64))||records.iter().any(|v|v["action"]=="error"){return Err(format!("Packaged editor self-test failed: {records:?}"))}
 unsafe extern "C" {fn av_editor_runtime_path(output:*mut u16,capacity:i32)->i32;}
 let mut path=vec![0u16;32768];let length=unsafe{av_editor_runtime_path(path.as_mut_ptr(),path.len() as i32)};
 if length<=0||length as usize>=path.len(){return Err("Loaded runtime path unavailable.".into())}
 let runtime=std::path::PathBuf::from(String::from_utf16_lossy(&path[..length as usize]));
 if !runtime.starts_with(directory.join("dotnet")){return Err(format!("Editor used a runtime outside the package: {}",runtime.display()))}
 Ok(json!({"sessions":3,"sameProcess":true,"runtime":runtime,"fixture":fixtures[0]}))
}
#[cfg(test)]mod tests{
 use super::*;
 static EDITOR_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
 #[test]fn focus_cancel_leaves_foreground_with_the_user(){assert!(!restore_after_error(Some(crate::capture_service::FOCUS_CANCEL)));assert!(restore_after_error(Some("Editor library is damaged.")));assert!(restore_after_error(None));}
 #[test]fn rejects_unbounded_or_invalid_messages(){assert!(decode_header(&[0;MAX_HEADER+1],&[]).is_err());assert!(decode_header(b"invalid",&[]).is_err());assert!(decode_header(br#"{"action":"check"}"#,&[]).is_ok());}
 #[test]fn stale_sessions_reject_output_before_processing(){let mut output=|_:&str,_:&str,_:&[u8]|panic!("Stale output must not run");let mut session=Session{check:&||Err("Preview cancelled.".into()),output:&mut output,captured:None,error:None};assert!(session.handle(json!({"action":"copy","format":"png"}),&[]).is_err());assert_eq!(session.error.as_deref(),Some("Preview cancelled."));}
 #[test]fn real_managed_library_runs_repeatedly_in_this_process_without_capture(){
  let _guard = EDITOR_TEST_LOCK.lock().unwrap();
  let directory=std::env::var_os("AV_EDITOR_LIBRARY").expect("Verify must provide the built library path");let mut records=Vec::<Value>::new();
  unsafe extern "C" fn receive(context:*mut c_void,h:*const u8,n:i32,_:*const u8,b:i32,r:*mut u8,c:i32)->i32{if b!=0||c<12||n<2||n>MAX_HEADER as i32{return -1}let Ok(value)=serde_json::from_slice::<Value>(std::slice::from_raw_parts(h,n as usize))else{return -1};let records=&mut *(context as *mut Vec<Value>);let checks=records.iter().filter(|v|v["action"]=="check").count();let cancel=value["action"]=="check"&&records.iter().any(|v|v["cancelFixture"]==true||v["timerFixture"]==true&&checks>=1);records.push(value);let reply=if cancel{b"{\"ok\":false}".as_slice()}else{b"{\"ok\":true}".as_slice()};std::ptr::copy_nonoverlapping(reply.as_ptr(),r,reply.len());reply.len() as i32}
  for _ in 0..12{invoke(Path::new(&directory),br#"{"mode":"self-test"}"#,&[],&mut records as *mut _ as *mut c_void,receive).unwrap();}
  let fixtures:Vec<_>=records.iter().filter(|v|v["action"]=="fixture").collect();assert_eq!(fixtures.len(),12);for fixture in fixtures{assert_eq!(fixture["pid"].as_u64(),Some(std::process::id() as u64));assert!(fixture["title"].as_str().unwrap().contains("All View"));assert!(!fixture["title"].as_str().unwrap().contains("ShareX"));assert!(fixture["details"].as_str().unwrap().contains("editable blur"));assert!(fixture["tools"].as_str().unwrap().contains("Copy and close"));}
  records.clear();records.push(json!({"cancelFixture":true}));invoke(Path::new(&directory),br#"{"mode":"self-test"}"#,&[],&mut records as *mut _ as *mut c_void,receive).unwrap();assert!(!records.iter().any(|v|v["action"]=="fixture"));
  records.clear();records.push(json!({"timerFixture":true}));invoke(Path::new(&directory),br#"{"mode":"cancel-test"}"#,&[],&mut records as *mut _ as *mut c_void,receive).unwrap();assert!(records.iter().any(|v|v["action"]=="cancelled-fixture"));assert!(!records.iter().any(|v|v["action"]=="error"));
  let path:Vec<u16>=Path::new(&directory).as_os_str().encode_wide().chain(Some(0)).collect();let mut error=[0u8;1024];let mut forged=Request{version:1,header_len:MAX_HEADER as i32+1,header:b"{}".as_ptr(),image_len:0,image:std::ptr::null(),context:&mut records as *mut _ as *mut c_void,send:receive};assert_eq!(unsafe{av_editor_run(path.as_ptr(),&mut forged as *mut _ as *mut c_void,std::mem::size_of::<Request>() as i32,error.as_mut_ptr(),error.len() as i32)},-2);
 }
 #[test]
 fn editor_tool_preferences_survive_reopening_and_storage_failures() {
  let _guard = EDITOR_TEST_LOCK.lock().unwrap();
  let library = std::env::var_os("AV_EDITOR_LIBRARY").expect("Verify must provide the built library path");
  let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
  let scratch = std::env::temp_dir().join(format!("editor-preferences-{}-{timestamp}", std::process::id()));
  let mut records = Vec::<Value>::new();
  unsafe extern "C" fn receive(context:*mut c_void, header:*const u8, length:i32, _:*const u8, bytes:i32, reply:*mut u8, capacity:i32)->i32 {
   if bytes != 0 || !(2..=MAX_HEADER as i32).contains(&length) || capacity < 11 { return -1 }
   let Ok(value) = serde_json::from_slice::<Value>(std::slice::from_raw_parts(header, length as usize)) else { return -1 };
   (&mut *(context as *mut Vec<Value>)).push(value);
   let response = b"{\"ok\":true}";
   std::ptr::copy_nonoverlapping(response.as_ptr(), reply, response.len());
   response.len() as i32
  }
  let header = serde_json::to_vec(&json!({"mode":"preferences-test", "directory":scratch})).unwrap();
  invoke(Path::new(&library), &header, &[], &mut records as *mut _ as *mut c_void, receive).unwrap();
  assert!(!records.iter().any(|record| record["action"] == "error"), "{records:?}");
  assert!(records.iter().any(|record| record["action"] == "preferences-fixture"), "{records:?}");
 }
}
