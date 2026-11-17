use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::Read, os::windows::process::CommandExt, path::Path,
    process::{Command, Stdio}, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant}};

const MAX_OUTPUT: u64 = 2 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub token: usize,
    pub pid: u32,
    pub created: String,
    pub executable: String,
    pub paths: Vec<String>,
    pub protected_reason: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub scan_id: u64,
    pub processes: Vec<Process>,
    pub partial: bool,
    pub inaccessible: u32,
    pub elapsed_ms: u64,
}
pub struct Snapshot { pub owner: u64, pub report: Report }
extern "C" {
    fn av_lock_scan(path: *const u16, context: *mut std::ffi::c_void,
        callback: extern "C" fn(*mut std::ffi::c_void, u32, u64, *const u16, *const u16, *const u16), inaccessible: *mut u32) -> i32;
    fn av_lock_release(pid: u32, created: u64, force: bool) -> i32;
}
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(Some(0)).collect()
}
unsafe fn string(value: *const u16) -> String {
    let mut n = 0;
    while n < 32768 && *value.add(n) != 0 { n += 1; }
    String::from_utf16_lossy(std::slice::from_raw_parts(value, n))
}
extern "C" fn matched(context: *mut std::ffi::c_void, pid: u32, created: u64, exe: *const u16, path: *const u16, reason: *const u16) {
    let processes = unsafe { &mut *(context as *mut BTreeMap<u32, Process>) };
    let row = processes.entry(pid).or_insert_with(|| Process {
        token: 0, pid, created: created.to_string(), executable: unsafe { string(exe) },
        paths: Vec::new(), protected_reason: unsafe { string(reason) },
    });
    row.paths.push(unsafe { string(path) });
}
// Runs before Tauri/single-instance setup, never inside the resident process.
pub fn worker(path: &Path) -> Result<Report, String> {
    let start = Instant::now(); let mut processes: BTreeMap<u32, Process> = BTreeMap::new(); let mut inaccessible = 0;
    let status = unsafe { av_lock_scan(wide(path.as_os_str()).as_ptr(), &mut processes as *mut _ as *mut _, matched, &mut inaccessible) };
    if status < 0 { return Err(match status {
        -2 => "Windows could not inspect this path. It may have moved, be inaccessible or be exclusively locked.",
        -3 => "Choose the actual file or folder; lock inspection does not follow reparse points or links.",
        -4 => "The Windows handle table exceeded the 128 MiB inspection budget.",
        _ => "Windows handle inspection is unavailable on this system.",
    }.into()); }
    let processes = processes.into_values().enumerate().map(|(n, mut row)| {row.token = n + 1; row}).collect();
    Ok(Report { scan_id: 0, processes, partial: status != 0, inaccessible, elapsed_ms: start.elapsed().as_millis() as u64 })
}
pub fn scan(path: &Path, generation: &AtomicU64, expected: u64) -> Result<Report, String> {
    let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .arg("--lock-worker").arg(path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .creation_flags(0x08000000).spawn().map_err(|e| format!("Could not start lock inspection: {e}"))?;
    let output = child.stdout.take().ok_or("Lock inspector output unavailable.")?;
    let reader = std::thread::spawn(move || { let mut bytes = Vec::new(); output.take(MAX_OUTPUT + 1).read_to_end(&mut bytes).map(|_| bytes) });
    let start = Instant::now();
    let result = loop {
        if generation.load(Ordering::SeqCst) != expected { break Err("Lock inspection cancelled.".to_string()); }
        if start.elapsed() > Duration::from_secs(15) { break Err("Lock inspection timed out. Windows stalled on a handle; no complete result is available. Try refreshing.".to_string()); }
        match child.try_wait() {
            Ok(Some(status)) => break if status.success() { Ok(()) } else { Err("The lock inspector could not complete.".into()) },
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => break Err(e.to_string()),
        }
    };
    if result.is_err() { let _ = child.kill(); }
    let _ = child.wait();
    let bytes = reader.join().map_err(|_| "Lock inspector output failed.")?.map_err(|e| e.to_string())?;
    result?;
    if bytes.len() as u64 > MAX_OUTPUT { return Err("Lock inspection exceeded the result budget.".into()); }
    let value: Result<Report, String> = serde_json::from_slice(&bytes).map_err(|_| "Invalid lock inspector response.")?;
    let mut report = value?;
    if report.processes.len() > 2048 || report.processes.iter().any(|p| p.paths.len() > 8) { return Err("Invalid lock result limits.".into()); }
    report.scan_id = expected;
    Ok(report)
}
pub fn observed<'a>(report: &'a Report, token: usize) -> Result<&'a Process, String> {
    report.processes.iter().find(|row| row.token == token).ok_or_else(|| "Refresh the lock list before choosing an application.".into())
}
pub fn still_observed(previous: &Process, fresh: &Report) -> bool {
    fresh.processes.iter().any(|p| p.pid == previous.pid && p.created == previous.created)
}
pub fn release(process: &Process, force: bool) -> Result<String, String> {
    if !process.protected_reason.is_empty() { return Err(format!("Release unavailable: {}.", process.protected_reason)); }
    let created = process.created.parse().map_err(|_| "Invalid process identity.")?;
    match unsafe { av_lock_release(process.pid, created, force) } {
        2 => Ok("Process termination requested. Refresh to check whether the path is still in use.".into()),
        1 => Ok("Close requested. Save or dismiss any prompt in that application, then refresh.".into()),
        0 => Err("This application has no closable window. Close it yourself or use the confirmed End process action.".into()),
        -2 => Err("The application exited or its identity changed. Refresh the list.".into()),
        -3 => Err("This process is protected from release.".into()),
        _ => Err("Windows denied the release request. The application may have exited or require different permissions.".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    extern "C" { fn av_test_lock_paths() -> bool; }
    #[test] fn folder_boundaries_and_own_process_are_protected() { assert!(unsafe { av_test_lock_paths() }); }
    #[test] fn cancelled_generation_stops_the_disposable_inspector() {
        let result=scan(Path::new("unused-cancelled-fixture"),&AtomicU64::new(2),1);
        assert!(matches!(result,Err(ref error) if error=="Lock inspection cancelled."));
    }
    #[test] fn release_identity_requires_same_birth_and_native_token() {
        let row = Process { token: 7, pid: 42, created: "100".into(), executable: "fixture".into(), paths: vec![], protected_reason: "".into() };
        let mut report = Report { scan_id: 3, processes: vec![row.clone()], partial: false, inaccessible: 0, elapsed_ms: 1 };
        assert!(observed(&report, 8).is_err()); assert!(still_observed(&row, &report));
        report.processes[0].created = "101".into(); assert!(!still_observed(&row, &report));
        report.processes.clear(); assert!(!still_observed(&row, &report));
    }
}
