//! Explicit Windows handoff. Callers supply only a native-authorized current path.
use std::{path::Path,os::windows::ffi::OsStrExt};
extern "C"{fn av_open_external(owner:isize,path:*const u16,choose:bool)->i32;}
fn path_argument(path:&Path,choose:bool)->Result<Vec<u16>,String>{
    if !path.is_absolute(){return Err("Choose an absolute local file path.".into())}
    let metadata=std::fs::metadata(path).map_err(|_|"This file is no longer available. Reopen its preview.")?;
    if !(metadata.is_file()||metadata.is_dir()&&!choose){return Err("Open with is available for files only.".into())}
    let mut argument:Vec<u16>=path.as_os_str().encode_wide().collect();
    if argument.is_empty()||argument.len()>=32767||argument.contains(&0){return Err("The file path cannot be opened by Windows.".into())}
    argument.push(0);Ok(argument)
}
pub fn open(owner:isize,path:&Path,choose:bool)->Result<(),String>{
    let argument=path_argument(path,choose)?;
    match unsafe{av_open_external(owner,argument.as_ptr(),choose)}{
        0=>Ok(()),code=>Err(format!("Windows could not open this file (0x{:08X}). Try Open with… to choose an application.",code as u32))
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn windows_handoff_preserves_literal_unicode_paths_and_rejects_invalid_targets(){
        let root=std::env::temp_dir().join(format!("av-open-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));std::fs::create_dir_all(&root).unwrap();
        let file=root.join("تجربة & notes (1).txt");std::fs::write(&file,b"authored source").unwrap();
        for choose in [false,true]{let argument=path_argument(&file,choose).unwrap();assert_eq!(argument.last(),Some(&0));assert_eq!(std::ffi::OsString::from_wide(&argument[..argument.len()-1]),file.as_os_str());}
        assert!(path_argument(&root,false).is_ok());assert!(path_argument(&root,true).is_err());assert!(path_argument(Path::new("relative.txt"),false).is_err());assert!(path_argument(&root.join("missing.txt"),false).is_err());
        assert_eq!(std::fs::read(&file).unwrap(),b"authored source");std::fs::remove_file(file).unwrap();std::fs::remove_dir(root).unwrap();
    }
    use std::os::windows::ffi::OsStringExt;
}
