use serde::{Serialize,Deserialize};
use std::{collections::HashMap, fs::File, io::Read, path::Path, sync::OnceLock};

pub const TEXT_LIMIT: u64 = 8 * 1024 * 1024;
pub const BINARY_LIMIT: u64 = 64 * 1024 * 1024;
pub const PIXEL_LIMIT: u64 = 40_000_000;

pub fn format_kind(path: &Path) -> &'static str {
    #[derive(Deserialize)] struct Route {kind:String}
    static FORMATS: OnceLock<HashMap<String, Route>> = OnceLock::new();
    let formats = FORMATS.get_or_init(|| serde_json::from_str(include_str!("../../src/formats.json")).expect("valid format registry"));
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
    let extension = path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
    if let Some(entry) = formats.get(&extension).or_else(||formats.get(name.trim_start_matches('.'))) {
        return &entry.kind;
    }
    if ["readme","license","licence","copying","authors","changelog","makefile","dockerfile"].contains(&name.as_str()) { "text" } else { "unsupported" }
}
pub fn is_text(kind: &str) -> bool { ["text","markdown","json","svg","html","notebook","calendar","email"].contains(&kind) }
pub fn is_media(kind: &str) -> bool { matches!(kind,"audio"|"video") }
fn mime_for(path: &Path, kind: &str) -> &'static str {
    let extension=path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
    match (kind,extension.as_str()) {
        ("image","png"|"apng")=>"image/png", ("image","jpg"|"jpeg"|"jpe"|"jfif")=>"image/jpeg", ("image","webp")=>"image/webp",
        ("image","gif")=>"image/gif", ("image","avif")=>"image/avif", ("image","bmp")=>"image/bmp", ("image",_)=>"image/x-icon",
        ("audio","mp3"|"mp2")=>"audio/mpeg", ("audio","wav"|"wave")=>"audio/wav", ("audio","flac")=>"audio/flac",
        ("audio","m4a"|"m4b"|"m4r")=>"audio/mp4", ("audio","aac")=>"audio/aac", ("audio",_)=>"audio/ogg",
        ("video","webm")=>"video/webm", ("video","ogv")=>"video/ogg", ("video","mkv")=>"video/x-matroska", ("video",_)=>"video/mp4",
        ("font","woff")=>"font/woff", ("font","woff2")=>"font/woff2", ("font","otf")=>"font/otf", ("font",_)=>"font/ttf",
        ("pdf",_)=>"application/pdf", _=>"application/octet-stream"
    }
}
fn extensionless_text(path: &Path, bytes: u64) -> bool {
    if path.extension().is_some() || bytes > TEXT_LIMIT { return false; }
    let mut header=[0u8;4096];
    let count=match File::open(path).and_then(|mut file|file.read(&mut header)){Ok(count)=>count,Err(_)=>return false};
    let sample=&header[..count];
    if sample.starts_with(&[0xff,0xfe]) || sample.starts_with(&[0xfe,0xff]) { return true; }
    !sample.iter().any(|byte|*byte<0x20&&!matches!(*byte,b'\t'|b'\n'|b'\r'|0x0c))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub mime: String,
    pub bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
fn metadata_info(path: &Path) -> Result<FileInfo, String> {
    let meta = path.metadata().map_err(|e| format!("Cannot open this file: {e}"))?;
    if meta.is_dir() {return Ok(FileInfo{name:path.file_name().unwrap_or_default().to_string_lossy().into(),path:path.to_string_lossy().into(),kind:"directory".into(),mime:"inode/directory".into(),bytes:0,width:None,height:None})}
    if !meta.is_file() { return Err("Select a file or folder to preview.".into()); }
    let mut kind = format_kind(path);
    if kind=="unsupported" && extensionless_text(path,meta.len()) { kind="text"; }
    if kind=="unsupported" { return Err("A full visual renderer for this format is not implemented yet. See the format coverage report.".into()); }
    let mime = mime_for(path,kind);
    let limit = if is_text(kind) { TEXT_LIMIT } else { BINARY_LIMIT };
    if kind=="pdf" && meta.len()>crate::pdf_service::MAX_BYTES{return Err("This PDF exceeds the 2 GiB reader limit.".into())}
    if !is_media(kind) && kind!="pdf" && meta.len() > limit {
        return Err(format!("This file is too large to preview. The limit for this format is {} MiB.", limit / 1024 / 1024));
    }
    Ok(FileInfo { name: path.file_name().unwrap_or_default().to_string_lossy().into(), path: path.to_string_lossy().into(),
        kind: kind.into(), mime: mime.into(), bytes: meta.len(), width:None, height:None })
}
pub fn inspect(path: &Path) -> Result<FileInfo, String> {
    let mut info=metadata_info(path)?;
    if info.kind == "image" {
        let dimensions = image::ImageReader::open(path).map_err(|_| "Cannot read this image.")?
            .with_guessed_format().map_err(|_| "Cannot identify this image.")?
            .into_dimensions().map_err(|_| "This image is damaged or unsupported.")?;
        if u64::from(dimensions.0) * u64::from(dimensions.1) > PIXEL_LIMIT {
            return Err("This image exceeds the 40 megapixel preview limit.".into());
        }
        info.width=Some(dimensions.0);info.height=Some(dimensions.1);
    }
    Ok(info)
}
// Product loading uses one bounded read. Image geometry and PDF signatures are
// checked against the exact bytes delivered, not a preceding path inspection.
pub fn load(path: &Path) -> Result<(FileInfo,Vec<u8>), String> {
    let mut info = metadata_info(path)?;
    if info.kind=="directory"{return Ok((info,Vec::new()))}
    if info.kind=="pdf"{let session=crate::pdf_service::Session::open(0,path)?;info.bytes=session.length();return Ok((info,Vec::new()))}
    // Media is read on demand by the current-request-only range protocol.
    // Never allocate a buffer proportional to a movie's size.
    if is_media(&info.kind) {
        File::open(path).map_err(|e|format!("Cannot read this media: {e}"))?;
        return Ok((info,Vec::new()))
    }
    let limit = if is_text(&info.kind) { TEXT_LIMIT } else { BINARY_LIMIT };
    let file = File::open(path).map_err(|e| format!("Cannot read this file: {e}"))?;
    let mut bytes = Vec::with_capacity(info.bytes as usize);
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|e| format!("Cannot read this file: {e}"))?;
    if bytes.len() as u64 > limit { return Err("The file grew beyond the preview limit. Open a smaller file.".into()); }
    if info.kind == "image" {
        // Validate the delivered bytes too: a file can change after metadata inspection.
        let (width,height)=image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format()
            .map_err(|_| "Cannot identify this image.")?.into_dimensions().map_err(|_| "This image is damaged or unsupported.")?;
        if u64::from(width)*u64::from(height)>PIXEL_LIMIT { return Err("This image exceeds the 40 megapixel preview limit.".into()); }
        info.width=Some(width);info.height=Some(height);
    }
    if info.kind == "pdf" && !bytes.starts_with(b"%PDF-") { return Err("This is not a valid PDF file.".into()); }
    info.bytes=bytes.len() as u64;
    Ok((info,bytes))
}
pub fn read(path: &Path) -> Result<Vec<u8>, String> {
    let (info,bytes)=load(path)?;
    if info.kind=="directory" {return Err("Use the folder tree to inspect directories.".into())}
    if info.kind=="pdf" {return Err("Use bounded PDF ranges to read this document.".into())}
    if is_media(&info.kind) {return Err("Use the local media stream for audio/video content.".into())}
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};
    fn fixture(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("allview-test-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap(); root.join(name)
    }
    #[test] fn unicode_path_read_is_exact_and_read_only() {
        let path = fixture("العربية and spaces.md"); let bytes = "# Sample\nالعربية **text**\n".as_bytes();
        fs::write(&path, bytes).unwrap();
        let info = inspect(&path).unwrap(); assert_eq!(info.kind, "markdown");
        assert_eq!(read(&path).unwrap(), bytes); assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    #[test] fn large_text_is_rejected_before_reading() {
        let path = fixture("large.txt"); File::create(&path).unwrap().set_len(TEXT_LIMIT + 1).unwrap();
        assert!(read(&path).unwrap_err().contains("too large"));
    }
    #[test] fn executable_and_directory_are_not_opened_as_content() {
        let path = fixture("sample.exe"); fs::write(&path, b"MZ").unwrap();
        assert!(inspect(&path).is_err()); assert_eq!(inspect(path.parent().unwrap()).unwrap().kind,"directory");assert!(read(path.parent().unwrap()).is_err());
    }
    #[test] fn damaged_pdf_and_image_report_errors() {
        let pdf = fixture("broken.pdf"); fs::write(&pdf, b"Not a PDF").unwrap(); assert!(read(&pdf).is_err());
        let image = fixture("broken.png"); fs::write(&image, b"Not an image").unwrap(); assert!(inspect(&image).is_err());
    }
    #[test] fn combined_load_describes_the_exact_delivered_image_bytes() {
        let path=fixture("same-read.png");
        image::RgbaImage::new(3,2).save(&path).unwrap();
        let original=fs::read(&path).unwrap();
        let (info,bytes)=load(&path).unwrap();
        assert_eq!((info.width,info.height),(Some(3),Some(2)));
        assert_eq!(info.bytes,bytes.len() as u64);assert_eq!(bytes,original);
        fs::write(&path,b"damaged replacement").unwrap();
        assert!(load(&path).is_err());
        let (folder,data)=load(path.parent().unwrap()).unwrap();assert_eq!(folder.kind,"directory");assert!(data.is_empty());
    }
    #[test] fn code_dotfiles_and_template_routes_preserve_source_bytes() {
        for name in ["example.rs",".gitignore","Dockerfile","notes-without-extension"] {
            let path=fixture(name);let original=b"# sample content\n";fs::write(&path,original).unwrap();
            assert_eq!(inspect(&path).unwrap().kind,"text");assert_eq!(read(&path).unwrap(),original);assert_eq!(fs::read(&path).unwrap(),original);
        }
        assert_eq!(format_kind(Path::new("document.docx")),"engine-word");
        assert_eq!(format_kind(Path::new("workbook.numbers")),"engine-iwork");
        assert_eq!(format_kind(Path::new("sample.dwg")),"engine-cad");
    }
}
