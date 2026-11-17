//! Local, read-only media ranges. No frontend-supplied paths or whole-file buffers.
use std::{fs::File,io::{Read,Seek,SeekFrom},path::Path};
use tauri::http::{Request,Response};

pub const CHUNK_LIMIT:u64=1024*1024;
pub const MAX_INFLIGHT:usize=4;

pub fn request_id(request:&Request<Vec<u8>>)->Option<u64>{
    let path=request.uri().path().strip_prefix('/')?;
    if request.uri().query().is_some()||path.is_empty()||!path.bytes().all(|b|b.is_ascii_digit()){return None}
    path.parse().ok().filter(|id|*id>0)
}
pub fn empty(status:u16)->Response<Vec<u8>>{
    Response::builder().status(status).header("Cache-Control","no-store").body(Vec::new()).unwrap()
}
fn range(value:Option<&str>,length:u64)->Option<(u64,u64)>{
    if length==0{return None}
    let (start,end)=if let Some(value)=value {
        let (first,last)=value.strip_prefix("bytes=")?.split_once('-')?;
        let number=|text:&str|if !text.is_empty()&&text.bytes().all(|b|b.is_ascii_digit()){text.parse::<u64>().ok()}else{None};
        if first.is_empty(){let suffix=number(last)?;if suffix==0{return None}(length.saturating_sub(suffix),length-1)}
        else {let start=number(first)?;let end=if last.is_empty(){length-1}else{number(last)?.min(length-1)};(start,end)}
    }else{(0,length-1)};
    if start>=length||end<start{return None}
    Some((start,start+(end-start).min(CHUNK_LIMIT-1)))
}
pub fn response(path:&Path,request:&Request<Vec<u8>>)->Response<Vec<u8>>{
    if request.method()!="GET"&&request.method()!="HEAD"{
        let mut response=empty(405);response.headers_mut().insert("Allow","GET, HEAD".parse().unwrap());return response
    }
    let Ok(info)=crate::file_service::inspect(path) else{return empty(404)};
    if !crate::file_service::is_media(&info.kind){return empty(403)}
    let Ok(mut file)=File::open(path) else{return empty(404)};
    let Ok(metadata)=file.metadata() else{return empty(404)};
    if !metadata.is_file(){return empty(403)}
    let length=metadata.len();
    let builder=Response::builder().header("Content-Type",info.mime).header("Accept-Ranges","bytes")
        .header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff");
    if request.method()=="HEAD"{return builder.status(200).header("Content-Length",length).body(Vec::new()).unwrap()}
    let header=match request.headers().get("Range"){Some(value)=>match value.to_str(){Ok(value)=>Some(value),Err(_)=>return empty(416)},None=>None};
    let Some((start,end))=range(header,length) else{
        return builder.status(416).header("Content-Range",format!("bytes */{length}")).body(Vec::new()).unwrap()
    };
    let mut bytes=vec![0;(end-start+1) as usize];
    if file.seek(SeekFrom::Start(start)).and_then(|_|file.read_exact(&mut bytes)).is_err(){return empty(409)}
    // Even an open-ended or absent Range is capped. WebView2 continues from
    // Content-Range; seeking can jump directly to metadata or frames near EOF.
    builder.status(206).header("Content-Range",format!("bytes {start}-{end}/{length}"))
        .header("Content-Length",bytes.len()).body(bytes).unwrap()
}

#[cfg(test)] mod tests{
    use super::*;
    fn request(value:&str)->Request<Vec<u8>>{Request::builder().uri("http://av-media.localhost/1").header("Range",value).body(Vec::new()).unwrap()}
    #[test] fn ranges_are_bounded_and_support_large_offsets_suffixes_and_eof(){
        let length=5*1024*1024*1024u64;
        assert_eq!(range(Some("bytes=0-"),length),Some((0,CHUNK_LIMIT-1)));
        assert_eq!(range(None,length),Some((0,CHUNK_LIMIT-1)));
        assert_eq!(range(Some("bytes=4294967296-"),length),Some((4294967296,4294967296+CHUNK_LIMIT-1)));
        assert_eq!(range(Some("bytes=-128"),length),Some((length-128,length-1)));
        assert_eq!(range(Some("bytes=90-999"),100),Some((90,99)));
        for header in ["bytes=100-","bytes=9-1","bytes=-0","bytes=a-1","bytes=+1-3","bytes=0-1,4-5","items=0-1","bytes=18446744073709551616-"]{assert_eq!(range(Some(header),100),None,"{header}")}
        assert_eq!(range(None,0),None);
    }
    #[test] fn protocol_urls_only_accept_numeric_request_identity(){
        for uri in ["http://av-media.localhost/1","av-media://localhost/42"]{assert!(request_id(&Request::builder().uri(uri).body(vec![]).unwrap()).is_some())}
        for uri in ["http://av-media.localhost/0","http://av-media.localhost/C:/movie.mp4","http://av-media.localhost/1?path=other","http://av-media.localhost/%31","http://av-media.localhost/../1"]{assert!(request_id(&Request::builder().uri(uri).body(vec![]).unwrap()).is_none())}
    }
    #[test] fn large_media_has_metadata_only_payload_and_exact_read_only_tail_ranges(){
        let root=std::env::temp_dir().join(format!("av-media-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();let path=root.join("العربية movie.mp4");
        let length=5*1024*1024*1024u64;
        let mut file=File::create(&path).unwrap();
        #[cfg(windows)] {
            use std::os::windows::io::AsRawHandle;
            extern "system"{fn DeviceIoControl(handle:*mut std::ffi::c_void,code:u32,input:*const std::ffi::c_void,input_size:u32,output:*mut std::ffi::c_void,output_size:u32,returned:*mut u32,overlapped:*mut std::ffi::c_void)->i32;}
            let mut returned=0;
            assert_ne!(unsafe{DeviceIoControl(file.as_raw_handle(),0x900c4,std::ptr::null(),0,std::ptr::null_mut(),0,&mut returned,std::ptr::null_mut())},0,"mark authored test movie sparse");
        }
        file.set_len(length).unwrap();
        use std::io::Write;file.seek(SeekFrom::End(-4)).unwrap();file.write_all(b"tail").unwrap();drop(file);
        let (info,bytes)=crate::file_service::load(&path).unwrap();assert_eq!(info.bytes,length);assert!(bytes.is_empty());
        let data=crate::preview_payload::encode(&info,bytes).unwrap();assert!(data.len()<1024);
        let result=response(&path,&request("bytes=-4"));assert_eq!(result.status(),206);assert_eq!(result.body(),b"tail");
        assert_eq!(result.headers()["content-range"],format!("bytes {}-{}/{length}",length-4,length-1));
        let result=response(&path,&request("bytes=0-"));assert_eq!(result.body().len(),CHUNK_LIMIT as usize);
        let head=Request::builder().method("HEAD").body(vec![]).unwrap();let result=response(&path,&head);assert_eq!(result.status(),200);assert!(result.body().is_empty());assert_eq!(result.headers()["content-length"],length.to_string());
        assert_eq!(response(&path,&request(&format!("bytes={length}-"))).status(),416);
        assert_eq!(response(&path,&Request::builder().method("POST").body(vec![]).unwrap()).status(),405);
        let binary=root.join("large.pdf");File::create(&binary).unwrap().set_len(crate::file_service::BINARY_LIMIT+1).unwrap();assert!(crate::file_service::load(&binary).is_err());
        let text=root.join("sample.txt");std::fs::write(&text,b"private").unwrap();assert_eq!(response(&text,&request("bytes=0-")).status(),403);
        assert_eq!(std::fs::metadata(&path).unwrap().len(),length);let mut tail=[0;4];let mut original=File::open(&path).unwrap();original.seek(SeekFrom::End(-4)).unwrap();original.read_exact(&mut tail).unwrap();assert_eq!(&tail,b"tail");drop(original);
        std::fs::remove_dir_all(root).unwrap();
    }
}
