use serde::Serialize;
use std::{cmp::Ordering, ffi::OsString, fs, path::{Path, PathBuf}};

pub const ENTRY_LIMIT: usize = 20_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Navigation {
    pub position: usize,
    pub total: usize,
    pub previous: Option<String>,
    pub next: Option<String>,
}
struct Entry { name: OsString, key: String }
pub struct Folder { parent: PathBuf, entries: Vec<Entry>, index: usize }

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let (a,b)=(left.as_bytes(),right.as_bytes());
    let (mut i,mut j)=(0,0);
    while i<a.len() && j<b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let (start_a,start_b)=(i,j);
            while i<a.len() && a[i].is_ascii_digit() {i+=1}
            while j<b.len() && b[j].is_ascii_digit() {j+=1}
            let (mut x,mut y)=(start_a,start_b);
            while x+1<i && a[x]==b'0' {x+=1}
            while y+1<j && b[y]==b'0' {y+=1}
            let order=(i-x).cmp(&(j-y)).then_with(||a[x..i].cmp(&b[y..j]));
            if order!=Ordering::Equal {return order}
        } else {
            let order=a[i].cmp(&b[j]);
            if order!=Ordering::Equal {return order}
            i+=1;j+=1;
        }
    }
    (a.len()-i).cmp(&(b.len()-j)).then_with(||left.cmp(right))
}
impl Folder {
    pub fn navigation(&self) -> Navigation {
        Navigation {position:self.index+1,total:self.entries.len(),previous:self.index.checked_sub(1).map(|i|self.entries[i].name.to_string_lossy().into()),next:self.entries.get(self.index+1).map(|e|e.name.to_string_lossy().into())}
    }
    pub fn adjacent(&self, direction: i8) -> Result<PathBuf,String> {
        let index=match direction {
            -1=>self.index.checked_sub(1),
            1=>self.index.checked_add(1).filter(|&i|i<self.entries.len()),
            _=>return Err("Choose previous or next file.".into()),
        }.ok_or_else(||"You have reached the end of this folder.".to_string())?;
        Ok(self.parent.join(&self.entries[index].name))
    }
}
pub fn scan(current: &Path) -> Result<Folder,String> {
    let current=std::path::absolute(current).map_err(|_|"Cannot locate this file's folder.")?;
    let parent=current.parent().ok_or("This file has no containing folder.")?.to_path_buf();
    let name=current.file_name().ok_or("Select a file to browse its folder.")?;
    let mut entries=Vec::new();
    for (count,entry) in fs::read_dir(&parent).map_err(|_|"Cannot read this file's folder.")?.enumerate() {
        if count>=ENTRY_LIMIT {return Err("Folder navigation is unavailable above 20,000 entries.".into())}
        let entry=entry.map_err(|_|"The folder changed while being read. Try again.")?;
        if !entry.file_type().map_err(|_|"Cannot read a folder entry.")?.is_file() {continue}
        let name=entry.file_name();let key=name.to_string_lossy().to_lowercase();
        entries.push(Entry{name,key});
    }
    entries.sort_by(|a,b|natural_cmp(&a.key,&b.key).then_with(||a.name.cmp(&b.name)));
    let key=name.to_string_lossy().to_lowercase();
    let index=entries.iter().position(|e|e.name==name).or_else(||entries.iter().position(|e|e.key==key))
        .ok_or("This file is no longer in its folder. Open another file to continue.")?;
    Ok(Folder{parent,entries,index})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let root=std::env::temp_dir().join(format!("allview-folder-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap();root
    }
    #[test] fn browsing_orders_numbers_skips_folders_and_preserves_files() {
        let root=root();
        for name in ["Page10.txt","page2.txt","page1.txt","العربية.md","unsupported.dat"] {fs::write(root.join(name),name.as_bytes()).unwrap()}
        fs::create_dir(root.join("page3.txt")).unwrap();
        let folder=scan(&root.join("page2.txt")).unwrap();
        assert_eq!(folder.navigation().total,5);
        assert_eq!(folder.adjacent(-1).unwrap(),root.join("page1.txt"));
        assert_eq!(folder.adjacent(1).unwrap(),root.join("Page10.txt"));
        assert_eq!(fs::read(root.join("page2.txt")).unwrap(),b"page2.txt");
    }
    #[test] fn boundaries_do_not_wrap_or_accept_other_directions() {
        let root=root();fs::write(root.join("only.txt"),b"one").unwrap();
        let folder=scan(&root.join("only.txt")).unwrap();
        assert!(folder.navigation().previous.is_none());assert!(folder.navigation().next.is_none());
        for direction in [-1,0,1,2] {assert!(folder.adjacent(direction).is_err())}
    }
    #[test] fn rescan_reflects_changes_and_navigation_stays_in_the_parent() {
        let root=root();fs::write(root.join("1.txt"),b"one").unwrap();fs::write(root.join("3.txt"),b"three").unwrap();
        assert_eq!(scan(&root.join("1.txt")).unwrap().adjacent(1).unwrap(),root.join("3.txt"));
        fs::write(root.join("2.txt"),b"two").unwrap();
        assert_eq!(scan(&root.join("1.txt")).unwrap().adjacent(1).unwrap(),root.join("2.txt"));
        assert!(scan(&root.join("missing.txt")).is_err());
    }
}
