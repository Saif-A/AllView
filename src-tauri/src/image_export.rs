//! Explicit image output. Only a current, unchanged PNG/JPEG edit grant permits replacement.
use std::{path::Path,io::Write};
use std::path::PathBuf;
extern "C"{fn av_image_identity(path:*const u16,values:*mut u64)->bool;fn av_replace_image(source:*const u16,replacement:*const u16)->bool;fn av_copy_image(owner:isize,rgba:*const u8,w:u32,h:u32,png:*const u8,length:usize)->bool;}
fn wide(path:&Path)->Vec<u16>{use std::os::windows::ffi::OsStrExt;path.as_os_str().encode_wide().chain(Some(0)).collect()}
#[derive(Clone)]pub struct EditGrant{pub id:u64,pub path:PathBuf,pub format:String,identity:[u64;6]}
impl EditGrant{pub fn unchanged(&self)->bool{identity(&self.path).map(|value|value==self.identity).unwrap_or(false)}}
fn identity(path:&Path)->Result<[u64;6],String>{let mut values=[0u64;6];if !unsafe{av_image_identity(wide(path).as_ptr(),values.as_mut_ptr())}{return Err("Replacement requires a regular image file without a reparse link.".into())}if values[5]!=1{return Err("Replacement is disabled for hard-linked images; save a copy.".into())}Ok(values)}
pub fn edit_grant(id:u64,path:&Path)->Result<EditGrant,String>{
 identity(path)?;let canonical=path.canonicalize().map_err(|e|e.to_string())?;
 let extension=path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();let format=match extension.as_str(){"png"=>"png","jpg"|"jpeg"=>"jpg",_=>return Err("Save and replace is available for PNG/JPEG; other formats can be saved as a new image.".into())};
 Ok(EditGrant{id,path:canonical.clone(),format:format.into(),identity:identity(&canonical)?})
}
pub fn save_dated(directory:&Path,stamp:&str,bytes:&[u8],format:&str)->Result<PathBuf,String>{
 validate(bytes,format)?;std::fs::create_dir_all(directory).map_err(|e|e.to_string())?;
 for index in 1..=10000{let suffix=if index==1{String::new()}else{format!(" ({index})")};let path=directory.join(format!("{stamp}{suffix}.{format}"));
 match std::fs::OpenOptions::new().write(true).create_new(true).open(&path){Ok(mut file)=>{file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|e|e.to_string())?;return Ok(path)},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>continue,Err(e)=>return Err(e.to_string())}
 }Err("Too many captures have the same timestamp.".into())
}
pub fn replace(grant:&mut EditGrant,bytes:&[u8],format:&str)->Result<(),String>{
 validate(bytes,format)?;if format!=grant.format{return Err("Save and replace must preserve the original PNG/JPEG format.".into())}
 if identity(&grant.path)?!=grant.identity{return Err("The source image changed outside the editor. Reopen it or save a copy.".into())}
 static SEQUENCE:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(1);
 let temp=grant.path.with_file_name(format!(".allview-edit-{}-{}.{}",std::process::id(),SEQUENCE.fetch_add(1,std::sync::atomic::Ordering::Relaxed),format));
 save_new(&temp,bytes,format)?;
 let result=(||{if identity(&grant.path)?!=grant.identity{return Err("The source image changed; replacement cancelled.".into())}if !unsafe{av_replace_image(wide(&grant.path).as_ptr(),wide(&temp).as_ptr())}{return Err(format!("Windows could not replace the image: {}",std::io::Error::last_os_error()))}grant.identity=identity(&grant.path)?;Ok(())})();
 if temp.exists(){let _=std::fs::remove_file(&temp);}result
}
pub fn copy(owner:isize,bytes:&[u8])->Result<(),String>{validate(bytes,"png")?;let image=image::load_from_memory(bytes).map_err(|e|e.to_string())?.into_rgba8();if unsafe{av_copy_image(owner,image.as_ptr(),image.width(),image.height(),bytes.as_ptr(),bytes.len())}{Ok(())}else{Err("Windows clipboard is busy. Try Copy again.".into())}}
pub fn jpeg_from_png(bytes:&[u8])->Result<Vec<u8>,String>{
 validate(bytes,"png")?;let image=image::load_from_memory(bytes).map_err(|e|e.to_string())?.into_rgba8();
 let mut rgb=image::RgbImage::new(image.width(),image.height());
 for (source,destination) in image.pixels().zip(rgb.pixels_mut()){let alpha=u32::from(source[3]);for channel in 0..3{destination[channel]=((u32::from(source[channel])*alpha+255*(255-alpha)+127)/255) as u8;}}
 let mut encoded=std::io::Cursor::new(Vec::new());image::DynamicImage::ImageRgb8(rgb).write_to(&mut encoded,image::ImageFormat::Jpeg).map_err(|e|e.to_string())?;
 let bytes=encoded.into_inner();validate(&bytes,"jpg")?;Ok(bytes)
}
pub fn validate(bytes:&[u8],format:&str)->Result<(),String>{
    if bytes.is_empty()||bytes.len()>64*1024*1024{return Err("Export is empty or exceeds 64 MiB.".into())}
    if !matches!(format,"png"|"jpg")||!(if format=="png"{bytes.starts_with(b"\x89PNG\r\n\x1a\n")}else{bytes.starts_with(&[0xff,0xd8,0xff])}){return Err("Export must be a valid PNG or JPEG.".into())}
    let dimensions=image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|e|e.to_string())?.into_dimensions().map_err(|e|e.to_string())?;
    if u64::from(dimensions.0)*u64::from(dimensions.1)>16_000_000{return Err("Edited exports are limited to 16 megapixels.".into())}
    let mut reader=image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|e|e.to_string())?;let mut limits=image::Limits::default();limits.max_alloc=Some(128*1024*1024);reader.limits(limits);reader.decode().map_err(|e|format!("Export image data is damaged: {e}"))?;Ok(())
}
pub fn save_new(destination:&Path,bytes:&[u8],format:&str)->Result<(),String>{
    validate(bytes,format)?;let name=destination.file_name().and_then(|n|n.to_str()).ok_or("Choose a normal image filename.")?;
    if name.contains(':')||name.ends_with('.')||name.ends_with(' '){return Err("Alternate data streams and special filenames cannot be exported.".into())}
    let base=name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON","PRN","AUX","NUL"].contains(&base.as_str())||(base.len()==4&&(base.starts_with("COM")||base.starts_with("LPT"))&&matches!(base.as_bytes()[3],b'1'..=b'9')){return Err("Choose a regular image filename, not a Windows device name.".into())}
    let extension=destination.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !(extension==format||format=="jpg"&&extension=="jpeg"){return Err(format!("Use a .{format} filename for this export."))}
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(destination).map_err(|e|format!("Choose a new filename; existing files are preserved. {e}"))?;
    file.write_all(bytes).and_then(|_|file.flush()).map_err(|e|format!("Could not finish export: {e}"))
}
#[cfg(test)]mod tests {
    use super::*;
    fn png()->Vec<u8>{let image=image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2,3,image::Rgb([200,100,50])));let mut cursor=std::io::Cursor::new(Vec::new());image.write_to(&mut cursor,image::ImageFormat::Png).unwrap();cursor.into_inner()}
    #[test]fn save_as_jpeg_preserves_dimensions_and_uses_white_for_transparent_pixels(){let image=image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(8,8,image::Rgba([0,0,0,0])));let mut cursor=std::io::Cursor::new(Vec::new());image.write_to(&mut cursor,image::ImageFormat::Png).unwrap();let output=jpeg_from_png(&cursor.into_inner()).unwrap();let decoded=image::load_from_memory(&output).unwrap().into_rgb8();assert_eq!(decoded.dimensions(),(8,8));assert!(decoded.pixels().all(|p|p.0.iter().all(|v|*v>=250)));}
    fn fixture(name:&str)->PathBuf{let root=std::env::temp_dir().join(format!("av-{name}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));std::fs::create_dir_all(&root).unwrap();root}
    #[test]fn dated_exports_keep_existing_files_and_use_collision_suffixes(){let root=fixture("dated");let bytes=png();let stamp="2026-01-23 12-32-33 AM";let first=save_dated(&root,stamp,&bytes,"png").unwrap();let second=save_dated(&root,stamp,&bytes,"png").unwrap();assert_eq!(first.file_name().unwrap(),"2026-01-23 12-32-33 AM.png");assert_eq!(second.file_name().unwrap(),"2026-01-23 12-32-33 AM (2).png");assert_eq!(std::fs::read(first).unwrap(),bytes);std::fs::remove_dir_all(root).unwrap();}
    #[test]fn replace_requires_unchanged_grant_preserves_format_and_atomically_updates(){let root=fixture("replace");let path=root.join("source.png");let bytes=png();std::fs::write(&path,&bytes).unwrap();let mut grant=edit_grant(7,&path).unwrap();replace(&mut grant,&bytes,"png").unwrap();assert_eq!(std::fs::read(&path).unwrap(),bytes);assert!(replace(&mut grant,&bytes,"jpg").is_err());std::fs::write(&path,b"external change").unwrap();assert!(replace(&mut grant,&bytes,"png").is_err());assert_eq!(std::fs::read(&path).unwrap(),b"external change");assert_eq!(std::fs::read_dir(&root).unwrap().count(),1);std::fs::remove_dir_all(root).unwrap();}
    #[test]fn export_creates_a_new_file_and_preserves_every_existing_destination(){let root=std::env::temp_dir().join(format!("av-export-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));std::fs::create_dir_all(&root).unwrap();let path=root.join("original.png");std::fs::write(&path,b"original bytes").unwrap();let bytes=png();assert!(save_new(&path,&bytes,"png").is_err());assert_eq!(std::fs::read(&path).unwrap(),b"original bytes");let output=root.join("copy.png");save_new(&output,&bytes,"png").unwrap();assert_eq!(std::fs::read(&output).unwrap(),bytes);assert!(save_new(&root.join("wrong.jpg"),&bytes,"png").is_err());}
    #[test]fn malformed_and_mismatched_formats_are_rejected(){assert!(validate(b"not an image","png").is_err());assert!(validate(&png(),"jpg").is_err());assert!(validate(&png()[..33],"png").is_err());validate(&png(),"png").unwrap();for name in ["original.png:copy.png","NUL.png","COM1.png"]{assert!(save_new(Path::new(name),&png(),"png").is_err())}}
}
