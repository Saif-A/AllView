use std::path::PathBuf;
pub const FOCUS_CANCEL:&str="Capture cancelled after focus changed.";
extern "C"{
 fn av_capture_home(buffer:*mut u16,size:i32)->bool;
 fn av_local_time(values:*mut u16);
}
pub fn directory()->Result<PathBuf,String>{let mut buffer=vec![0u16;32768];if !unsafe{av_capture_home(buffer.as_mut_ptr(),buffer.len() as i32)}{return Err("Windows Pictures folder is unavailable.".into())}let len=buffer.iter().position(|v|*v==0).ok_or("Pictures path is invalid.")?;Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..len])).join("All View").join("Captures"))}
pub fn timestamp()->String{let mut values=[0u16;6];unsafe{av_local_time(values.as_mut_ptr())};stamp(values)}
fn stamp(t:[u16;6])->String{format!("{:04}-{:02}-{:02} {:02}-{:02}-{:02} {}",t[0],t[1],t[2],if t[3]%12==0{12}else{t[3]%12},t[4],t[5],if t[3]>=12{"PM"}else{"AM"})}
pub fn capture()->Result<Option<Vec<u8>>,String>{
 crate::sharex_service::capture()
}
#[derive(Debug,PartialEq)]
pub enum CaptureOutput{Copied,Saved(PathBuf)}
/// Keep clipboard-only captures out of the filesystem, including on failure/cancellation.
pub fn finish_capture(
 bytes:Option<&[u8]>,clipboard_only:bool,
 copy:impl FnOnce(&[u8])->Result<(),String>,
 save:impl FnOnce(&[u8])->Result<PathBuf,String>,
)->Result<Option<CaptureOutput>,String>{
 let Some(bytes)=bytes else{return Ok(None)};
 if clipboard_only{copy(bytes)?;Ok(Some(CaptureOutput::Copied))}
 else{save(bytes).map(|path|Some(CaptureOutput::Saved(path)))}
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn twelve_hour_names_handle_midnight_noon_and_padding(){assert_eq!(stamp([2026,1,23,0,32,33]),"2026-01-23 12-32-33 AM");assert_eq!(stamp([2026,1,23,12,32,33]),"2026-01-23 12-32-33 PM");assert_eq!(stamp([2026,1,23,23,2,3]),"2026-01-23 11-02-03 PM");}
 extern "C"{fn av_test_clipboard_layout()->bool;}
 #[test]fn authored_clipboard_pixels_are_top_down_bgra_without_changing_clipboard(){assert!(unsafe{av_test_clipboard_layout()});}
 #[test]fn active_viewer_capture_copies_without_saving_even_when_clipboard_fails(){
  let pixels=b"authored capture";
  assert_eq!(finish_capture(Some(pixels),true,|bytes|{assert_eq!(bytes,pixels);Ok(())},|_|panic!("Clipboard capture must not save")),Ok(Some(CaptureOutput::Copied)));
  assert_eq!(finish_capture(Some(pixels),true,|_|Err("Clipboard busy".into()),|_|panic!("Failure must not save a fallback")),Err("Clipboard busy".into()));
 }
 #[test]fn hidden_viewer_capture_preserves_save_handoff_and_cancel_has_no_output(){
  let pixels=b"authored capture";let path=PathBuf::from("capture.png");
  assert_eq!(finish_capture(Some(pixels),false,|_|panic!("Hidden capture must not change clipboard"),|bytes|{assert_eq!(bytes,pixels);Ok(path.clone())}),Ok(Some(CaptureOutput::Saved(path))));
  for clipboard_only in [false,true]{assert_eq!(finish_capture(None,clipboard_only,|_|panic!("Cancelled copy"),|_|panic!("Cancelled save")),Ok(None));}
 }
}
