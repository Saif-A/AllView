use crate::file_service::FileInfo;

// A small length-prefixed JSON descriptor followed by binary file bytes. Avoid
// JSON/base64 encoding the content or a second metadata/read IPC round trip.
pub fn encode(info: &FileInfo, bytes: Vec<u8>) -> Result<Vec<u8>,String> {
    let mut header=serde_json::json!({"version":1,"info":info});
    if info.kind=="pdf"{if !bytes.is_empty(){return Err("PDF content must use bounded ranges.".into())}header["transport"]=serde_json::json!("pdf");}
    if crate::file_service::is_media(&info.kind) {
        if !bytes.is_empty(){return Err("Media content must use bounded streaming.".into())}
        header["transport"]=serde_json::json!("media");
    }
    let metadata=serde_json::to_vec(&header).map_err(|e|e.to_string())?;
    if metadata.len()>256*1024 {return Err("Preview metadata exceeds its limit.".into())}
    let mut result=Vec::with_capacity(4+metadata.len()+bytes.len());
    result.extend_from_slice(&(metadata.len() as u32).to_le_bytes());result.extend_from_slice(&metadata);result.extend(bytes);Ok(result)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn metadata_and_arbitrary_binary_remain_separate_and_exact() {
        let info=FileInfo{name:"العربية.png".into(),path:"C:/fixture/العربية.png".into(),kind:"image".into(),mime:"image/png".into(),bytes:4,width:Some(3),height:Some(2)};
        let result=encode(&info,vec![0,255,128,10]).unwrap();
        let size=u32::from_le_bytes(result[..4].try_into().unwrap()) as usize;
        let header:serde_json::Value=serde_json::from_slice(&result[4..4+size]).unwrap();
        assert_eq!(header["version"],1);assert_eq!(header["info"]["name"],"العربية.png");
        assert_eq!(&result[4+size..],&[0,255,128,10]);
    }
}
