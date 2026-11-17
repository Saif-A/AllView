//! One direct-open policy for initial and forwarded Windows launches.
use std::path::{Path,PathBuf};

#[derive(Debug,PartialEq)]
pub struct Launch {pub path:Option<PathBuf>,pub quiet:bool}
pub fn is_update_exit(args:&[String])->bool{args.len()==2&&args[1]=="--quit-for-update"}
pub fn parse(args:&[String],cwd:&Path)->Result<Launch,String>{
    let mut path=None;let mut quiet=false;let mut literal=false;let mut expect_path=false;
    for arg in args.iter().skip(1){
        if !literal&&arg=="--"{literal=true;continue}
        if !literal&&arg=="--background"&&!expect_path{quiet=true;continue}
        if !literal&&arg=="--open"&&!expect_path{expect_path=true;continue}
        if !literal&&arg.starts_with('-'){return Err(format!("Unknown option: {arg}. Use All View.exe [--background] [--open] <path>."))}
        if path.is_some()||arg.is_empty(){return Err("Open one file or folder at a time.".into())}
        let requested=PathBuf::from(arg);
        // Resolve against the launching process, including forwarded invocations.
        let requested=if requested.is_absolute(){requested}else{
            // Drive-relative and rooted-without-drive paths depend on Windows'
            // per-drive cwd. Do not resolve them against the resident process.
            if requested.has_root()||matches!(requested.components().next(),Some(std::path::Component::Prefix(_))){return Err("Use a complete path or a path relative to the current folder.".into())}
            cwd.join(requested)
        };
        path=Some(requested);expect_path=false;
    }
    if expect_path{return Err("--open requires a file or folder path.".into())}
    Ok(Launch{path,quiet})
}

#[cfg(test)]mod tests{
    use super::*;
    fn args(values:&[&str])->Vec<String>{std::iter::once("All View.exe").chain(values.iter().copied()).map(str::to_owned).collect()}
    #[test]fn update_shutdown_cannot_be_combined_with_file_opening(){assert!(is_update_exit(&args(&["--quit-for-update"])));assert!(!is_update_exit(&args(&["--quit-for-update","file.png"])));assert!(!is_update_exit(&args(&["--","--quit-for-update"])));}
    #[test]fn empty_launch_is_notification_only_and_background_is_quiet(){
        let cwd=Path::new("C:/caller");
        assert_eq!(parse(&args(&[]),cwd).unwrap(),Launch{path:None,quiet:false});
        assert_eq!(parse(&args(&["--background"]),cwd).unwrap(),Launch{path:None,quiet:true});
    }
    #[test]fn paths_preserve_spaces_unicode_and_the_forwarding_working_directory(){
        let cwd=Path::new("C:/Caller folder");
        for input in [args(&["فيلم sample.mp4"]),args(&["--open","فيلم sample.mp4"]),args(&["--background","فيلم sample.mp4"]) ]{
            assert_eq!(parse(&input,cwd).unwrap().path,Some(cwd.join("فيلم sample.mp4")));
        }
        assert_eq!(parse(&args(&["D:/Movies/my video.mp4"]),cwd).unwrap().path,Some(PathBuf::from("D:/Movies/my video.mp4")));
        assert_eq!(parse(&args(&["--","--movie.mp4"]),cwd).unwrap().path,Some(cwd.join("--movie.mp4")));
        assert_eq!(parse(&args(&[r"\\server\share\movie.mp4"]),cwd).unwrap().path,Some(PathBuf::from(r"\\server\share\movie.mp4")));
    }
    #[test]fn malformed_options_and_multiple_paths_never_open_an_accidental_argument(){
        for values in [vec!["--open"],vec!["--bad","file.mp4"],vec!["first.mp4","second.mp4"],vec!["--open","--background"],vec![""],vec![r"D:relative.mp4"],vec![r"\rooted.mp4"]]{assert!(parse(&args(&values),Path::new("C:/caller")).is_err(),"{values:?}")}
    }
}
