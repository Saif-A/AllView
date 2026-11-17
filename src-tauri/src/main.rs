#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod file_service;
mod media_service;
mod pdf_service;
mod external_open;
mod folder_service;
mod directory_service;
mod lock_service;
mod image_export;
mod preview_payload;
mod window_geometry;
mod launch;
mod capture_service;
mod tray_gesture;
mod sharex_service;
mod ocr_cache;
mod identity;
use serde::Serialize;
use std::{path::PathBuf, sync::{Mutex, OnceLock, atomic::{AtomicBool, AtomicIsize, AtomicU64, AtomicUsize, Ordering}}};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

extern "C" {
    fn av_start(callback: extern "C" fn(*const u16, isize), foreground: extern "C" fn()) -> bool;
    fn av_has_foreground(window: isize) -> bool;
    fn av_tray_pointer_down(window:isize)->bool;
    fn av_set_enabled(value: bool);
    fn av_running() -> bool;
    fn av_restore(window: isize);
    fn av_stop();
    fn av_probe(buffer: *mut u16, size: i32) -> i32;
    fn av_autostart_enabled() -> bool;
    fn av_set_autostart(value: bool) -> bool;
    fn av_startup_choice_made() -> bool;
    fn av_get_pin(header: bool) -> bool;
    fn av_save_pin(header: bool, pinned: bool) -> bool;
    fn av_register_open_with(extensions: *const u16) -> bool;
    fn av_notify_started(window: isize, available: bool, message: *const u16) -> bool;
    fn av_clear_notification();
    fn av_control_shortcut()->bool;
    fn av_migrate_identity()->bool;
    fn av_double_click_time()->u32;
    fn av_open_directory(path:*const u16)->bool;
}
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRequest { id: u64, path: String, edit_image: bool }
struct AppState {
    pending: Mutex<Option<PreviewRequest>>,
    next_id: AtomicU64,
    enabled: AtomicBool,
    origin: AtomicIsize,
    pinned: AtomicBool,
    header_pinned: AtomicBool,
    picker_open: AtomicBool,
    external_opening: AtomicBool,
    focus_check_pending: AtomicBool,
    io: Mutex<()>,
    media_inflight: AtomicUsize,
    navigation: Mutex<()>,
    directory: Mutex<Option<(u64,directory_service::Snapshot)>>,
    scan_generation: AtomicU64,
    scan_busy: AtomicBool,
    tool_open: AtomicBool,
    startup_offer: AtomicBool,
    capture_busy: AtomicBool,
    tray_gesture: Mutex<tray_gesture::TrayGesture>,
    tray_timer_running: AtomicBool,
    image_edit: Mutex<Option<image_export::EditGrant>>,
    ocr_cache: Mutex<Option<ocr_cache::Session>>,
    pdf_session: Mutex<Option<pdf_service::Session>>,
    pdf_inflight: AtomicUsize,
    pdf_cache_preparing: AtomicBool,
    locks: Mutex<Option<lock_service::Snapshot>>,
    lock_generation: AtomicU64,
    lock_busy: AtomicBool,
    menu: Mutex<Option<tauri::menu::CheckMenuItem<tauri::Wry>>>,
}
impl Default for AppState {
    fn default() -> Self { Self {pending: Mutex::new(None), next_id: AtomicU64::new(1), enabled: AtomicBool::new(true), origin: AtomicIsize::new(0), pinned: AtomicBool::new(false), header_pinned: AtomicBool::new(false), picker_open: AtomicBool::new(false), focus_check_pending: AtomicBool::new(false), io: Mutex::new(()), media_inflight:AtomicUsize::new(0), navigation: Mutex::new(()), directory:Mutex::new(None),scan_generation:AtomicU64::new(0),scan_busy:AtomicBool::new(false),tool_open:AtomicBool::new(false),startup_offer:AtomicBool::new(false),capture_busy:AtomicBool::new(false),tray_gesture:Mutex::new(tray_gesture::TrayGesture::default()),tray_timer_running:AtomicBool::new(false),image_edit:Mutex::new(None),ocr_cache:Mutex::new(None),external_opening:AtomicBool::new(false),pdf_session:Mutex::new(None),pdf_inflight:AtomicUsize::new(0),pdf_cache_preparing:AtomicBool::new(false),locks:Mutex::new(None),lock_generation:AtomicU64::new(0),lock_busy:AtomicBool::new(false),menu: Mutex::new(None)} }
}
fn issue_request(app: &tauri::AppHandle, path: PathBuf, origin: isize) {
    issue_if_current(app,path,origin,None);
}
fn issue_if_current(app: &tauri::AppHandle, path: PathBuf, origin: isize, expected: Option<u64>) -> Option<PreviewRequest> {
    issue_mode(app,path,origin,expected,false)
}
fn issue_mode(app: &tauri::AppHandle, path: PathBuf, origin: isize, expected: Option<u64>,edit_image:bool) -> Option<PreviewRequest> {
    let state = app.state::<AppState>();
    if state.external_opening.load(Ordering::SeqCst){return None}
    let request;
    {
        let mut pending=state.pending.lock().ok()?;
        if let Some(id)=expected {if pending.as_ref().map(|r|r.id)!=Some(id) {return None}}
        request=PreviewRequest {id: state.next_id.fetch_add(1, Ordering::SeqCst), path: path.to_string_lossy().into(),edit_image};
        *pending=Some(request.clone());state.origin.store(origin, Ordering::SeqCst);
        state.scan_generation.fetch_add(1,Ordering::SeqCst);
        state.lock_generation.fetch_add(1,Ordering::SeqCst);
    }
    if let Ok(mut directory)=state.directory.lock(){*directory=None}
    if let Ok(mut cache)=state.ocr_cache.try_lock(){*cache=None}
    if let Ok(mut pdf)=state.pdf_session.lock(){*pdf=None}
    if let Ok(mut locks)=state.locks.lock(){*locks=None}
    if let Ok(mut edit)=state.image_edit.lock(){*edit=None}
    let presentation_app=app.clone();let presented=request.clone();
    let guard_explorer=expected.is_none() && origin!=0;
    let _=app.run_on_main_thread(move || {
        let state=presentation_app.state::<AppState>();
        if authorized_path(&state,presented.id).is_err() {return}
        // A queued COM result must not steal focus after the user switches apps.
        if guard_explorer && !unsafe{av_has_foreground(origin)} {return}
        // Execute as one UI operation: a foreground check cannot interleave
        // between showing the window and giving it focus.
        if let Some(window)=presentation_app.get_webview_window("main") {
            let _=window.unminimize();let _=window.show();let _=window.set_focus();
        }
        let _=presentation_app.emit("preview-request",presented);
    });Some(request)
}
extern "C" fn explorer_preview(path: *const u16, origin: isize) {
    if path.is_null() { return; }
    let mut length = 0; while length < 32768 && unsafe { *path.add(length) } != 0 { length += 1; }
    let value = String::from_utf16_lossy(unsafe {std::slice::from_raw_parts(path, length)});
    if let Some(app) = APP.get() { issue_request(app, PathBuf::from(value), origin); }
}
extern "C" fn foreground_changed() {
    let Some(app)=APP.get() else {return};
    if app.state::<AppState>().focus_check_pending.swap(true,Ordering::SeqCst) {return}
    let check_app=app.clone();
    if app.run_on_main_thread(move || {
        let state=check_app.state::<AppState>();state.focus_check_pending.store(false,Ordering::SeqCst);
        if state.pinned.load(Ordering::SeqCst) || state.picker_open.load(Ordering::SeqCst) || state.external_opening.load(Ordering::SeqCst) || state.tool_open.load(Ordering::SeqCst) || state.startup_offer.load(Ordering::SeqCst) || state.capture_busy.load(Ordering::SeqCst) {return}
        if state.tray_gesture.lock().map(|g|g.pending().is_some()).unwrap_or(false)||state.tray_timer_running.load(Ordering::SeqCst){return}
        if let Some(tray)=check_app.tray_by_id("resident"){let pressed=std::sync::Arc::new(AtomicBool::new(false));let output=pressed.clone();let _=tray.with_inner_tray_icon(move|inner|{output.store(unsafe{av_tray_pointer_down(inner.window_handle() as isize)},Ordering::SeqCst)});if pressed.load(Ordering::SeqCst){return}}
        if let Some(window)=check_app.get_webview_window("main") {
            if let Ok(handle)=window.hwnd() {
                if window.is_visible().unwrap_or(false) && !unsafe {av_has_foreground(handle.0 as isize)} {
                    hide_preview(&check_app,&state,false);
                }
            }
        }
    }).is_err() {app.state::<AppState>().focus_check_pending.store(false,Ordering::SeqCst)}
}
fn authorized_path(state: &AppState, id: u64) -> Result<PathBuf, String> {
    state.pending.lock().map_err(|_| "Preview state is unavailable.")?.as_ref()
        .filter(|request| request.id == id).map(|request| PathBuf::from(&request.path)).ok_or_else(|| "Preview cancelled.".into())
}
fn media_response(state:&AppState,request:&tauri::http::Request<Vec<u8>>)->tauri::http::Response<Vec<u8>>{
    let Some(id)=media_service::request_id(request) else{return media_service::empty(404)};
    let Ok(_reader)=state.io.lock() else{return media_service::empty(500)};
    let Ok(path)=authorized_path(state,id) else{return media_service::empty(410)};
    let response=media_service::response(&path,request);
    if authorized_path(state,id).is_err(){return media_service::empty(410)}
    response
}
#[tauri::command]
fn current_request(state: tauri::State<'_, AppState>) -> Option<PreviewRequest> { state.pending.lock().ok()?.clone() }
#[tauri::command]
async fn describe_request(id: u64, state: tauri::State<'_, AppState>) -> Result<file_service::FileInfo, String> {
    let path = authorized_path(&state, id)?;
    let result = tauri::async_runtime::spawn_blocking(move || file_service::inspect(&path)).await.map_err(|e| e.to_string())?;
    authorized_path(&state, id)?; result
}
#[tauri::command]
async fn read_content(id: u64, app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    authorized_path(&app.state::<AppState>(), id)?;
    let data = tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<AppState>();
        let _guard=state.io.lock().map_err(|_| "The file reader is unavailable.")?;
        let path=authorized_path(&state,id)?;
        let data=file_service::read(&path)?;
        authorized_path(&state,id)?;
        Ok::<Vec<u8>,String>(data)
    }).await.map_err(|e|e.to_string())??;
    Ok(tauri::ipc::Response::new(data))
}
#[tauri::command]
async fn load_preview(id:u64,app:tauri::AppHandle)->Result<tauri::ipc::Response,String>{
    authorized_path(&app.state::<AppState>(),id)?;
    let data=tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<AppState>();let _guard=state.io.lock().map_err(|_|"The file reader is unavailable.")?;
        let path=authorized_path(&state,id)?;
        let grant=if file_service::format_kind(&path)=="image"{image_export::edit_grant(id,&path).ok()}else{None};
        let (info,bytes)=file_service::load(&path)?;
        let pdf=if info.kind=="pdf"{Some(pdf_service::Session::open(id,&path)?)}else{None};
        if pdf.as_ref().is_some_and(|s|s.length()!=info.bytes){return Err("The PDF changed while opening. Reopen it.".into())}
        let cache=app.path().app_cache_dir().ok().and_then(|root|match info.kind.as_str(){"image"|"convert-image"|"svg"|"metafile"=>Some(ocr_cache::Session::image(id,&bytes,root.join("ocr-v1"))),_=>None});
        authorized_path(&state,id)?;
        *state.pdf_session.lock().map_err(|_|"PDF state unavailable.")?=pdf;
        *state.ocr_cache.lock().map_err(|_|"OCR cache state unavailable.")?=cache;
        *state.image_edit.lock().map_err(|_|"Edit state unavailable.")?=grant.filter(|g|g.unchanged());
        preview_payload::encode(&info,bytes)
    }).await.map_err(|e|e.to_string())??;
    Ok(tauri::ipc::Response::new(data))
}
#[tauri::command]
async fn open_external(id:u64,choose:bool,window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<(),String>{
    if window.label()!="main"{return Err("Open is available only from the viewer.".into())}
    let owner=window.hwnd().map_err(|e|e.to_string())?.0 as isize;
    let state=app.state::<AppState>();
    authorized_path(&state,id)?;
    if state.picker_open.load(Ordering::SeqCst)||state.capture_busy.load(Ordering::SeqCst){return Err("Finish the current dialog or capture first.".into())}
    if state.external_opening.swap(true,Ordering::SeqCst){return Err("An application chooser is already open.".into())}
    let work=app.clone();
    let result=tauri::async_runtime::spawn_blocking(move||{
        let state=work.state::<AppState>();
        struct Guard<'a>(&'a AtomicBool);impl Drop for Guard<'_>{fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}
        let _guard=Guard(&state.external_opening);
        let path=authorized_path(&state,id)?;
        external_open::open(owner,&path,choose)
    }).await.map_err(|e|e.to_string()).and_then(|r|r);
    foreground_changed();
    result
}
#[tauri::command]
async fn read_pdf_range(id:u64,begin:u64,end:u64,window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<tauri::ipc::Response,String>{
    if window.label()!="main"{return Err("PDF ranges are available only from the viewer.".into())}
    let state=app.state::<AppState>();authorized_path(&state,id)?;
    if state.pdf_inflight.try_update(Ordering::SeqCst,Ordering::SeqCst,|n|(n<4).then_some(n+1)).is_err(){return Err("PDF reader is busy.".into())}
    let result=tauri::async_runtime::spawn_blocking(move||{let state=app.state::<AppState>();struct Guard<'a>(&'a AtomicUsize);impl Drop for Guard<'_>{fn drop(&mut self){self.0.fetch_sub(1,Ordering::SeqCst);}}let _guard=Guard(&state.pdf_inflight);authorized_path(&state,id)?;let session=state.pdf_session.lock().map_err(|_|"PDF state unavailable.")?.clone().ok_or("No PDF is open.")?;let bytes=session.read(id,begin,end)?;authorized_path(&state,id)?;Ok::<_,String>(bytes)}).await.map_err(|e|e.to_string())??;Ok(tauri::ipc::Response::new(result))
}
#[tauri::command]
async fn prepare_pdf_cache(id:u64,window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<(),String>{
    if window.label()!="main"{return Err("PDF cache is available only from the viewer.".into())}let state=app.state::<AppState>();authorized_path(&state,id)?;
    if state.pdf_cache_preparing.swap(true,Ordering::SeqCst){return Err("PDF cache preparation is busy.".into())}
    tauri::async_runtime::spawn_blocking(move||{let state=app.state::<AppState>();struct Guard<'a>(&'a AtomicBool);impl Drop for Guard<'_>{fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}let _guard=Guard(&state.pdf_cache_preparing);let session=state.pdf_session.lock().map_err(|_|"PDF state unavailable.")?.clone().ok_or("No PDF is open.")?;
        let root=app.path().app_cache_dir().map_err(|e|e.to_string())?.join("ocr-v1");let source=session.cache_identity();session.check(id)?;
        let key=if let Some(key)=ocr_cache::Session::cached_digest(&root,&source){key}else{session.digest(id,ocr_cache::Session::hasher(),||{while state.pdf_inflight.load(Ordering::SeqCst)>0{if authorized_path(&state,id).is_err(){return false}std::thread::sleep(std::time::Duration::from_millis(2))}authorized_path(&state,id).is_ok()})?};
        let mut saved=state.ocr_cache.lock().map_err(|_|"OCR cache state unavailable.")?;authorized_path(&state,id)?;session.check(id)?;*saved=Some(ocr_cache::Session::from_digest(id,key,root,source));Ok(())
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn load_pdf_ocr_cache(id:u64,touch_only:Option<bool>,window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<tauri::ipc::Response,String>{
    if window.label()!="main"{return Err("OCR cache is available only from the viewer.".into())}authorized_path(&app.state::<AppState>(),id)?;
    let bytes=tauri::async_runtime::spawn_blocking(move||{let state=app.state::<AppState>();authorized_path(&state,id)?;let mut saved=state.ocr_cache.lock().map_err(|_|"OCR cache state unavailable.")?;if let Some(pdf)=state.pdf_session.lock().map_err(|_|"PDF state unavailable.")?.as_ref(){pdf.check(id)?}let cache=saved.as_mut().ok_or("OCR cache is unavailable.")?;if touch_only==Some(true){cache.used(id)?;authorized_path(&state,id)?;return Ok(b"[]".to_vec())}let pages=cache.load(id)?;authorized_path(&state,id)?;if let Some(pdf)=state.pdf_session.lock().map_err(|_|"PDF state unavailable.")?.as_ref(){pdf.check(id)?}serde_json::to_vec(&pages).map_err(|e|e.to_string())}).await.map_err(|e|e.to_string())??;Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
async fn save_pdf_ocr_page(request:tauri::ipc::Request<'_>,window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<(),String>{
    if window.label()!="main"{return Err("OCR cache is available only from the viewer.".into())}let id=request.headers().get("x-preview-id").and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<u64>().ok()).ok_or("Missing preview identity.")?;authorized_path(&app.state::<AppState>(),id)?;
    let bytes=match request.body(){tauri::ipc::InvokeBody::Raw(bytes) if bytes.len()<=4*1024*1024=>bytes.clone(),_=>return Err("OCR cache page exceeds its limit.".into())};
    tauri::async_runtime::spawn_blocking(move||{let state=app.state::<AppState>();authorized_path(&state,id)?;let mut cache=state.ocr_cache.lock().map_err(|_|"OCR cache state unavailable.")?;authorized_path(&state,id)?;if let Some(pdf)=state.pdf_session.lock().map_err(|_|"PDF state unavailable.")?.as_ref(){pdf.check(id)?}cache.as_mut().ok_or("OCR cache is unavailable.")?.save(id,&bytes)}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn fit_preview_window(id:u64,width:f64,height:f64,extra_height:f64,app:tauri::AppHandle)->Result<(),String>{
    authorized_path(&app.state::<AppState>(),id)?;
    let window=app.get_webview_window("main").ok_or("Preview window unavailable.")?;
    if window.is_maximized().unwrap_or(false)||window.is_fullscreen().unwrap_or(false){return Ok(())}
    let monitor=window.current_monitor().map_err(|e|e.to_string())?.ok_or("Monitor unavailable.")?;
    let dpi=monitor.scale_factor();let area=*monitor.work_area();
    let (w,h)=window_geometry::fit(width,height,area.size.width as f64/dpi,area.size.height as f64/dpi,extra_height)?;
    // Recheck at presentation time; an old decoder must never resize a newer file.
    let presentation=app.clone();
    app.run_on_main_thread(move||{
        if authorized_path(&presentation.state::<AppState>(),id).is_err()||window.is_maximized().unwrap_or(false)||window.is_fullscreen().unwrap_or(false){return}
        let _=window.set_size(tauri::LogicalSize::new(w,h));
        let x=area.position.x as f64+(area.size.width as f64-w*dpi)/2.0;
        let y=area.position.y as f64+(area.size.height as f64-h*dpi)/2.0;
        let _=window.set_position(tauri::PhysicalPosition::new(x.round() as i32,y.round() as i32));
    }).map_err(|e|e.to_string())
}
#[tauri::command]
async fn folder_status(id: u64, app: tauri::AppHandle) -> Result<folder_service::Navigation,String> {
    authorized_path(&app.state::<AppState>(),id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<AppState>();let _guard=state.navigation.lock().map_err(|_|"Folder navigation is unavailable.")?;
        let folder=folder_service::scan(&authorized_path(&state,id)?)?;
        authorized_path(&state,id)?;Ok(folder.navigation())
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn navigate_file(id: u64, direction: i8, app: tauri::AppHandle) -> Result<PreviewRequest,String> {
    authorized_path(&app.state::<AppState>(),id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<AppState>();let _guard=state.navigation.lock().map_err(|_|"Folder navigation is unavailable.")?;
        let path=folder_service::scan(&authorized_path(&state,id)?)?.adjacent(direction)?;
        let origin=state.origin.load(Ordering::SeqCst);
        issue_if_current(&app,path,origin,Some(id)).ok_or_else(||"Preview cancelled.".into())
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn scan_directory(id:u64,app:tauri::AppHandle)->Result<directory_service::Report,String>{
    let path=authorized_path(&app.state::<AppState>(),id)?;
    let root=if path.is_dir(){path}else{path.parent().ok_or("No containing folder.")?.to_path_buf()};
    let state=app.state::<AppState>();
    if state.scan_busy.swap(true,Ordering::SeqCst){return Err("A folder scan is stopping. Try again in a moment.".into())}
    let generation=state.scan_generation.fetch_add(1,Ordering::SeqCst)+1;
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<AppState>();
        let result=directory_service::scan(&root,&state.scan_generation,generation,|visited|{let _=app.emit("folder-progress",serde_json::json!({"id":id,"visited":visited}));});
        state.scan_busy.store(false,Ordering::SeqCst);
        let snapshot=result?;authorized_path(&state,id)?;
        if state.scan_generation.load(Ordering::SeqCst)!=generation{return Err("Folder scan cancelled.".into())}
        let report=snapshot.report.clone();*state.directory.lock().map_err(|_|"Folder state unavailable.")?=Some((id,snapshot));Ok(report)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn cancel_directory(state:tauri::State<'_,AppState>){state.scan_generation.fetch_add(1,Ordering::SeqCst);}
struct LockBusy<'a>(&'a AtomicBool);
impl Drop for LockBusy<'_> {fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}
#[tauri::command]
async fn scan_locks(id:u64,app:tauri::AppHandle)->Result<lock_service::Report,String>{
    let path=authorized_path(&app.state::<AppState>(),id)?;
    let state=app.state::<AppState>();
    if state.lock_busy.swap(true,Ordering::SeqCst){return Err("A lock operation is stopping. Try again in a moment.".into())}
    let generation=state.lock_generation.fetch_add(1,Ordering::SeqCst)+1;
    *state.locks.lock().map_err(|_|"Lock state unavailable.")?=None;
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<AppState>();let _busy=LockBusy(&state.lock_busy);
        let report=lock_service::scan(&path,&state.lock_generation,generation)?;
        authorized_path(&state,id)?;
        let mut snapshot=state.locks.lock().map_err(|_|"Lock state unavailable.")?;
        if state.lock_generation.load(Ordering::SeqCst)!=generation{return Err("Lock inspection cancelled.".into())}
        *snapshot=Some(lock_service::Snapshot{owner:id,report:report.clone()});Ok(report)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn cancel_locks(state:tauri::State<'_,AppState>){
    if let Ok(mut snapshot)=state.locks.lock(){state.lock_generation.fetch_add(1,Ordering::SeqCst);*snapshot=None}
}
#[tauri::command]
async fn release_lock(id:u64,scan_id:u64,token:usize,force:bool,app:tauri::AppHandle)->Result<String,String>{
    let state=app.state::<AppState>();let path=authorized_path(&state,id)?;
    if state.lock_busy.swap(true,Ordering::SeqCst){return Err("Another lock operation is running.".into())}
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<AppState>();let _busy=LockBusy(&state.lock_busy);
        let process={
            let mut saved=state.locks.lock().map_err(|_|"Lock state unavailable.")?;
            let snapshot=saved.as_ref().filter(|s|s.owner==id&&s.report.scan_id==scan_id&&state.lock_generation.load(Ordering::SeqCst)==scan_id).ok_or("Refresh the lock list before releasing an application.")?;
            let process=lock_service::observed(&snapshot.report,token)?.clone();
            if !process.protected_reason.is_empty(){return Err(format!("Release unavailable: {}.",process.protected_reason))}
            *saved=None;process
        };
        let fresh=lock_service::scan(&path,&state.lock_generation,scan_id)?;
        if !lock_service::still_observed(&process,&fresh){return Err("This application no longer appears to use the selected path. Refresh the list.".into())}
        // Keep request replacement and cancellation out of the final native action.
        let pending=state.pending.lock().map_err(|_|"Preview state unavailable.")?;
        let _snapshot=state.locks.lock().map_err(|_|"Lock state unavailable.")?;
        if pending.as_ref().map(|r|r.id)!=Some(id)||state.lock_generation.load(Ordering::SeqCst)!=scan_id{return Err("Lock release cancelled.".into())}
        lock_service::release(&process,force)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn open_tree_item(id:u64,token:usize,app:tauri::AppHandle)->Result<PreviewRequest,String>{
    let state=app.state::<AppState>();authorized_path(&state,id)?;
    let path={let snapshot=state.directory.lock().map_err(|_|"Folder state unavailable.")?;let (owner,tree)=snapshot.as_ref().ok_or("Scan the folder first.")?;if *owner!=id{return Err("Folder preview is outdated.".into())}tree.path(token)?};
    let origin=state.origin.load(Ordering::SeqCst);issue_if_current(&app,path,origin,Some(id)).ok_or_else(||"Preview cancelled.".into())
}
#[tauri::command]
fn open_containing_folder(id:u64,app:tauri::AppHandle)->Result<PreviewRequest,String>{
    let state=app.state::<AppState>();let path=authorized_path(&state,id)?;let parent=path.parent().ok_or("No parent folder.")?.to_path_buf();
    issue_if_current(&app,parent,state.origin.load(Ordering::SeqCst),Some(id)).ok_or_else(||"Preview cancelled.".into())
}
#[tauri::command]
fn pick_folder(app:tauri::AppHandle){
    if app.state::<AppState>().picker_open.swap(true,Ordering::SeqCst){return}
    let mut picker=app.dialog().file().set_title("Inspect folder in All View");if let Some(w)=app.get_webview_window("main"){picker=picker.set_parent(&w)}
    picker.pick_folder(move|file|{app.state::<AppState>().picker_open.store(false,Ordering::SeqCst);if let Some(file)=file{if let Ok(path)=file.into_path(){issue_request(&app,path,0)}}});
}
#[tauri::command]
async fn capture_for_editor(id:u64,app:tauri::AppHandle)->Result<tauri::ipc::Response,String>{
    authorized_path(&app.state::<AppState>(),id)?;
    if app.state::<AppState>().capture_busy.swap(true,Ordering::SeqCst){return Err("A capture is already running.".into())}
    if let Some(w)=app.get_webview_window("main"){let _=w.hide();}let _=app.emit("preview-hidden",());
    let work_app=app.clone();let result=tauri::async_runtime::spawn_blocking(move||{let bytes=capture_service::capture()?;authorized_path(&work_app.state::<AppState>(),id)?;Ok::<_,String>(bytes.unwrap_or_default())}).await.map_err(|e|e.to_string()).and_then(|r|r);
    app.state::<AppState>().capture_busy.store(false,Ordering::SeqCst);
    if sharex_service::restore_after_error(result.as_ref().err().map(String::as_str))&&authorized_path(&app.state::<AppState>(),id).is_ok(){if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}}
    result.map(tauri::ipc::Response::new)
}
#[tauri::command]
async fn edit_image_native(request:tauri::ipc::Request<'_>,window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<(),String>{
    if window.label()!="main"{return Err("Image editing is available only from the viewer.".into())}
    let id=request.headers().get("x-preview-id").and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<u64>().ok()).ok_or("Missing preview identity.")?;
    let light=request.headers().get("x-image-light").and_then(|v|v.to_str().ok())==Some("true");
    let bytes=match request.body(){tauri::ipc::InvokeBody::Raw(bytes) if !bytes.is_empty()&&bytes.len()<=64*1024*1024=>bytes.clone(),_=>return Err("Expected a PNG within 64 MiB.".into())};
    let source=authorized_path(&app.state::<AppState>(),id)?;
    if file_service::format_kind(&source)!="image"{return Err("This preview is not an editable image.".into())}
    if app.state::<AppState>().capture_busy.swap(true,Ordering::SeqCst){return Err("An image tool is already open.".into())}
    let work_app=app.clone();
    let result=tauri::async_runtime::spawn_blocking(move||{
        let state=work_app.state::<AppState>();
        image_export::validate(&bytes,"png")?;authorized_path(&state,id)?;
        let mut target=state.image_edit.lock().map_err(|_|"Edit state unavailable.")?.as_ref().filter(|g|g.id==id).cloned();
        let format=target.as_ref().map(|g|g.format.as_str()).unwrap_or("png");
        let header=serde_json::json!({"mode":"edit","name":source.file_name().and_then(|n|n.to_str()).unwrap_or("Image.png"),"format":format,"light":light});
        if let Some(w)=work_app.get_webview_window("main"){let _=w.hide();}let _=work_app.emit("preview-hidden",());
        sharex_service::edit(header,&bytes,||authorized_path(&state,id).map(|_|()),|action,format,bytes|{
            authorized_path(&state,id)?;
            if action=="save-as"{
                if format!="png"{return Err("Save as expects PNG output.".into())}
                let directory=capture_service::directory()?;
                if state.picker_open.swap(true,Ordering::SeqCst){return Err("Another file dialog is open.".into())}
                let destination=work_app.dialog().file().set_title("Save image as").set_directory(directory).set_file_name(format!("{}.png",capture_service::timestamp())).add_filter("PNG image",&["png"]).add_filter("JPEG image",&["jpg","jpeg"]).blocking_save_file();
                state.picker_open.store(false,Ordering::SeqCst);
                let Some(destination)=destination else{return Ok(serde_json::json!({"ok":true,"cancelled":true}))};
                let destination=destination.into_path().map_err(|e|e.to_string())?;
                let pending=state.pending.lock().map_err(|_|"Preview state unavailable.")?;
                if pending.as_ref().map(|r|r.id)!=Some(id){return Err("Preview cancelled.".into())}
                let jpeg=destination.extension().and_then(|e|e.to_str()).is_some_and(|e|e.eq_ignore_ascii_case("jpg")||e.eq_ignore_ascii_case("jpeg"));
                let encoded=if jpeg{Some(image_export::jpeg_from_png(bytes)?)}else{None};
                let format=if jpeg{"jpg"}else{"png"};let bytes=encoded.as_deref().unwrap_or(bytes);
                image_export::save_new(&destination,bytes,format)?;
                target=Some(image_export::edit_grant(id,&destination)?);
                return Ok(serde_json::json!({"ok":true,"path":destination.display().to_string(),"format":format}))
            }
            let pending=state.pending.lock().map_err(|_|"Preview state unavailable.")?;
            if pending.as_ref().map(|r|r.id)!=Some(id){return Err("Preview cancelled.".into())}
            if action=="copy"{
                if format!="png"{return Err("Clipboard output must be PNG.".into())}
                let owner=work_app.get_webview_window("main").ok_or("Viewer unavailable.")?.hwnd().map_err(|e|e.to_string())?.0 as isize;
                image_export::copy(owner,bytes)?;return Ok(serde_json::json!({"ok":true}))
            }
            if let Some(grant)=target.as_mut(){image_export::replace(grant,bytes,format)?;return Ok(serde_json::json!({"ok":true,"path":grant.path.display().to_string(),"format":grant.format}))}
            let path=image_export::save_dated(&capture_service::directory()?,&capture_service::timestamp(),bytes,format)?;
            target=Some(image_export::edit_grant(id,&path)?);
            Ok(serde_json::json!({"ok":true,"path":path.display().to_string(),"format":format}))
        })
    }).await.map_err(|e|e.to_string()).and_then(|r|r);
    app.state::<AppState>().capture_busy.store(false,Ordering::SeqCst);
    if result.is_err()&&sharex_service::restore_after_error(result.as_ref().err().map(String::as_str))&&authorized_path(&app.state::<AppState>(),id).is_ok(){let _=window.show();let _=window.set_focus();}
    result
}
#[tauri::command]
fn image_edit_context(id:u64,state:tauri::State<'_,AppState>)->Result<serde_json::Value,String>{
    let pending=state.pending.lock().map_err(|_|"Preview state unavailable.")?;
    pending.as_ref().filter(|r|r.id==id).ok_or("Preview cancelled.")?;
    let mut saved=state.image_edit.lock().map_err(|_|"Edit state unavailable.")?;
    if saved.as_ref().is_some_and(|grant|grant.id!=id||!grant.unchanged()){*saved=None}
    let format=saved.as_ref().map(|g|g.format.clone());
    Ok(serde_json::json!({"replaceFormat":format,"directory":capture_service::directory()?.display().to_string(),"filename":format!("{}.png",capture_service::timestamp())}))
}
#[tauri::command]
async fn save_image(request:tauri::ipc::Request<'_>,app:tauri::AppHandle)->Result<Option<String>,String>{
    let id=request.headers().get("x-preview-id").and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<u64>().ok()).ok_or("Missing preview identity.")?;
    let format=request.headers().get("x-image-format").and_then(|v|v.to_str().ok()).unwrap_or("png").to_string();
    let action=request.headers().get("x-image-action").and_then(|v|v.to_str().ok()).unwrap_or("dialog").to_string();
    if !matches!(action.as_str(),"dialog"|"default"|"replace"|"copy"){return Err("Unknown image output action.".into())}
    let bytes=match request.body(){tauri::ipc::InvokeBody::Raw(bytes)=>bytes.clone(),_=>return Err("Expected binary image content.".into())};
    let source=authorized_path(&app.state::<AppState>(),id)?;
    if bytes.len()>64*1024*1024||bytes.is_empty(){return Err("Export is empty or exceeds 64 MiB.".into())}
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<AppState>();authorized_path(&state,id)?;
        image_export::validate(&bytes,&format)?;
        authorized_path(&state,id)?;
        if action!="dialog"{
            let pending=state.pending.lock().map_err(|_|"Preview state unavailable.")?;
            if pending.as_ref().map(|r|r.id)!=Some(id){return Err("Preview cancelled.".into())}
            if action=="copy"{if format!="png"{return Err("Clipboard images must be PNG.".into())}let owner=app.get_webview_window("main").ok_or("Viewer unavailable.")?.hwnd().map_err(|e|e.to_string())?.0 as isize;image_export::copy(owner,&bytes)?;return Ok(Some("Copied image to clipboard".into()))}
            if action=="replace"{let mut saved=state.image_edit.lock().map_err(|_|"Edit state unavailable.")?;let grant=saved.as_mut().filter(|g|g.id==id).ok_or("Reopen the editor before replacing this image.")?;
                if source.canonicalize().map_err(|e|e.to_string())?!=grant.path{return Err("Source location changed; save a copy.".into())}image_export::replace(grant,&bytes,&format)?;return Ok(Some(grant.path.display().to_string()))}
            return image_export::save_dated(&capture_service::directory()?,&capture_service::timestamp(),&bytes,&format).map(|p|Some(p.display().to_string()))
        }
        let directory=capture_service::directory()?;
        if state.picker_open.swap(true,Ordering::SeqCst){return Err("Another native dialog is open.".into())}
        let name=format!("{}.{}",capture_service::timestamp(),format);
        let mut picker=app.dialog().file().set_title("Save edited image as a new file").set_directory(directory).set_file_name(name).add_filter("Image",&[format.as_str()]);
        if let Some(w)=app.get_webview_window("main"){picker=picker.set_parent(&w)}
        let destination=picker.blocking_save_file();state.picker_open.store(false,Ordering::SeqCst);
        let Some(destination)=destination else{return Ok(None)};authorized_path(&state,id)?;
        let destination=destination.into_path().map_err(|e|e.to_string())?;
        image_export::save_new(&destination,&bytes,&format)?;Ok(Some(destination.display().to_string()))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn set_tool_interaction(active:bool,state:tauri::State<'_,AppState>){state.tool_open.store(active,Ordering::SeqCst);}
#[tauri::command]
fn print_preview(window:tauri::WebviewWindow)->Result<(),String>{window.print().map_err(|e|e.to_string())}
#[tauri::command]
fn pick_file(app: tauri::AppHandle) {
    if app.state::<AppState>().picker_open.swap(true,Ordering::SeqCst) {return}
    let callback_app = app.clone();
    let mut picker=app.dialog().file().set_title("Open in All View");
    if let Some(window)=app.get_webview_window("main") {picker=picker.set_parent(&window)}
    picker
        .add_filter("Common previews", &["txt","md","json","pdf","png","jpg","svg","tif","docx","xlsx","pptx","epub","zip","mp3","mp4","stl"])
        .add_filter("All files", &["*"]).pick_file(move |file| {
            callback_app.state::<AppState>().picker_open.store(false,Ordering::SeqCst);
            if let Some(file) = file { if let Ok(path) = file.into_path() { issue_request(&callback_app, path, 0); } }
        });
}
#[tauri::command]
fn dismiss_preview(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    hide_preview(&app,&state,true);
}
fn hide_preview(app: &tauri::AppHandle, state: &AppState, restore: bool) {
    if state.external_opening.load(Ordering::SeqCst){return}
    cancel_locks(app.state::<AppState>());
    let origin = state.origin.swap(0, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    let _=app.emit("preview-hidden",());
    if restore && origin != 0 { unsafe { av_restore(origin) }; }
}
#[tauri::command]
fn set_pinned(state: tauri::State<'_,AppState>, pinned: bool) -> Result<bool,String> {
    if !unsafe{av_save_pin(false,pinned)}{return Err("Could not save the window pin preference.".into())}
    state.pinned.store(pinned,Ordering::SeqCst);Ok(pinned)
}
#[tauri::command]
fn set_header_pinned(state: tauri::State<'_,AppState>, pinned: bool) -> Result<bool,String> {
    if !unsafe{av_save_pin(true,pinned)}{return Err("Could not save the header pin preference.".into())}
    state.header_pinned.store(pinned,Ordering::SeqCst);Ok(pinned)
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Settings { enabled: bool, available: bool, autostart: bool, startup_prompt: bool, pinned: bool, header_pinned: bool }
#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    Settings {enabled:state.enabled.load(Ordering::SeqCst), available:unsafe {av_running()}, autostart:unsafe{av_autostart_enabled()},startup_prompt:state.startup_offer.load(Ordering::SeqCst),pinned:state.pinned.load(Ordering::SeqCst),header_pinned:state.header_pinned.load(Ordering::SeqCst)}
}
fn enable_listener(app: &tauri::AppHandle, value: bool) {
    let state = app.state::<AppState>(); state.enabled.store(value, Ordering::SeqCst); unsafe {av_set_enabled(value)};
    if let Ok(menu) = state.menu.lock() { if let Some(menu) = menu.as_ref() { let _=menu.set_checked(value); } }
    let _=app.emit("listener-changed", value);
}
#[tauri::command]
fn set_listener_enabled(app: tauri::AppHandle, enabled: bool) { enable_listener(&app, enabled); }
#[tauri::command]
fn set_autostart(state: tauri::State<'_,AppState>,enabled: bool) -> Result<(), String> {
    if !unsafe {av_set_autostart(enabled)} {return Err("Could not save Start with Windows. Check your Windows permissions and keep the app in a shorter path, then try again.".into())}
    state.startup_offer.store(false,Ordering::SeqCst);Ok(())
}
#[tauri::command]
fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {let value=!window.is_fullscreen().map_err(|e|e.to_string())?;window.set_fullscreen(value).map_err(|e|e.to_string())?;Ok(value)}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) { unsafe {av_stop()}; app.exit(0); }
fn icon() -> tauri::image::Image<'static> {tauri::image::Image::new_owned(include_bytes!("../icons/icon.rgba").to_vec(),32,32)}
fn configure_webview_shortcuts(window:&tauri::WebviewWindow)->tauri::Result<()>{
    window.with_webview(|webview|unsafe{
        use windows_core::Interface;
        use webview2_com::{AcceleratorKeyPressedEventHandler,Microsoft::Web::WebView2::Win32::*};
        let result=(||->windows_core::Result<()>{
            let controller=webview.controller();let settings=controller.CoreWebView2()?.Settings()?.cast::<ICoreWebView2Settings3>()?;
            settings.SetAreBrowserAcceleratorKeysEnabled(false)?;
            let handler=AcceleratorKeyPressedEventHandler::create(Box::new(|_,args|{
                if let Some(args)=args{let mut key=0;let mut kind=COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;args.VirtualKey(&mut key)?;args.KeyEventKind(&mut kind)?;
                    if key==0x46&&av_control_shortcut()&&(kind==COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN||kind==COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN){
                        args.SetHandled(true)?;let mut status=COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();args.PhysicalKeyStatus(&mut status)?;
                        if !status.WasKeyDown.as_bool(){if let Some(app)=APP.get(){let _=app.emit("find-requested",());}}
                    }
                }Ok(())
            }));let mut token=0;controller.add_AcceleratorKeyPressed(&handler,&mut token)?;Ok(())
        })();
        if let Err(error)=result{eprintln!("Could not disable built-in browser shortcuts: {error}")}
    })
}
fn launch_notice(app:&tauri::AppHandle,error:Option<&str>){
    if let Some(tray)=app.tray_by_id("resident"){
            let message=error.map(|message|message.encode_utf16().chain(Some(0)).collect::<Vec<_>>());
            let available=app.state::<AppState>().enabled.load(Ordering::SeqCst)&&unsafe{av_running()};
            let _=tray.with_inner_tray_icon(move|inner|unsafe{av_notify_started(inner.window_handle() as isize,available,message.as_ref().map_or(std::ptr::null(),|s|s.as_ptr()))});
    }
}
fn handle_launch(app:&tauri::AppHandle,args:&[String],cwd:&std::path::Path){
    if launch::is_update_exit(args){quit_app(app.clone());return}
    match launch::parse(args,cwd){
        Ok(launch)=>{
            let state=app.state::<AppState>();
            let offer=!launch.quiet&&!unsafe{av_startup_choice_made()};
            if offer{state.startup_offer.store(true,Ordering::SeqCst);}
            if let Some(path)=launch.path{issue_request(app,path,0)}else if !launch.quiet&&!offer{launch_notice(app,None)}
            if offer{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();let _=w.emit("startup-offer",());}}
        },
        Err(error)=>{eprintln!("{error}");launch_notice(app,Some(&error));}
    }
}
fn register_open_with(){
    let registry:serde_json::Value=serde_json::from_str(include_str!("../../src/formats.json")).expect("valid format registry");
    let mut extensions:Vec<_>=registry.as_object().unwrap().iter().filter(|(_,route)|route["kind"].as_str().is_some_and(|kind|kind!="unsupported")).map(|(ext,_)|ext.as_str()).collect();
    extensions.sort_unstable();let extensions:Vec<u16>=extensions.join(";").encode_utf16().chain(Some(0)).collect();
    if !unsafe{av_register_open_with(extensions.as_ptr())}{eprintln!("Could not register All View with Windows Open with. You can still choose the executable manually.")}
}
fn start_capture(app:&tauri::AppHandle){
    let state=app.state::<AppState>();if state.external_opening.load(Ordering::SeqCst)||state.capture_busy.swap(true,Ordering::SeqCst){return}
    let previous_id=state.pending.lock().ok().and_then(|p|p.as_ref().map(|r|r.id));
    let visible=app.get_webview_window("main").is_some_and(|w|w.is_visible().unwrap_or(false));
    // The tray takes foreground focus; snapshot viewer visibility before selection.
    let clipboard_only=visible;
    let app=app.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let result=(||{
            let bytes=capture_service::capture()?;
            capture_service::finish_capture(bytes.as_deref(),clipboard_only,|bytes|{
                let owner=app.get_webview_window("main").ok_or("Viewer unavailable.")?.hwnd().map_err(|e|e.to_string())?.0 as isize;
                image_export::copy(owner,bytes)
            },|bytes|image_export::save_dated(&capture_service::directory()?,&capture_service::timestamp(),bytes,"png"))
        })();
        let finish=app.clone();let _=app.run_on_main_thread(move||{
            match result{Ok(Some(capture_service::CaptureOutput::Saved(path)))=>{issue_mode(&finish,path,0,None,true);},other=>{
                if sharex_service::restore_after_error(other.as_ref().err().map(String::as_str)){if visible&&finish.state::<AppState>().pending.lock().ok().and_then(|p|p.as_ref().map(|r|r.id))==previous_id{if let Some(w)=finish.get_webview_window("main"){let _=w.show();let _=w.set_focus();}}if let Err(error)=other{launch_notice(&finish,Some(&error))}}
            }}
            finish.state::<AppState>().capture_busy.store(false,Ordering::SeqCst);
        });
    });
}
fn tray_now()->u64{static EPOCH:OnceLock<std::time::Instant>=OnceLock::new();EPOCH.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64}
fn handle_tray_event(app:&tauri::AppHandle,event:tauri::tray::TrayIconEvent){
    use tauri::tray::{TrayIconEvent,MouseButton,MouseButtonState};
    let state=app.state::<AppState>();let now=tray_now();let interval=u64::from(unsafe{av_double_click_time()}.clamp(1,5000));
    match event{
        TrayIconEvent::DoubleClick{button:MouseButton::Left,..}=>{
            if let Ok(mut gesture)=state.tray_gesture.lock(){gesture.double_clicked(now,interval)}
            let result=(||{let path=capture_service::directory()?;std::fs::create_dir_all(&path).map_err(|e|e.to_string())?;use std::os::windows::ffi::OsStrExt;let path:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();if !unsafe{av_open_directory(path.as_ptr())}{return Err("Windows could not open the capture folder.".to_string())}Ok(())})();
            if let Err(error)=result{launch_notice(app,Some(&error))}
        },
        TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}=>{
            let armed=state.tray_gesture.lock().ok().and_then(|mut g|g.released(now,interval)).is_some();
            if !armed||state.tray_timer_running.swap(true,Ordering::SeqCst){return}
            let app=app.clone();std::thread::spawn(move||loop{
                let state=app.state::<AppState>();
                let pending={let Ok(mut gesture)=state.tray_gesture.lock() else{state.tray_timer_running.store(false,Ordering::SeqCst);return};
                    let pending=gesture.pending();if pending.is_none(){state.tray_timer_running.store(false,Ordering::SeqCst);return}
                    let (token,deadline)=pending.unwrap();if tray_now()>=deadline&&gesture.take(token,tray_now()){state.tray_timer_running.store(false,Ordering::SeqCst);let capture_app=app.clone();let _=app.run_on_main_thread(move||{let current=capture_app.state::<AppState>().tray_gesture.lock().map(|g|g.is_current(token)).unwrap_or(false);if current{start_capture(&capture_app)}});return}deadline};
                std::thread::sleep(std::time::Duration::from_millis(pending.saturating_sub(tray_now()).clamp(1,50)));
            });
        },
        TrayIconEvent::Click{button:MouseButton::Right,..}=>{if let Ok(mut gesture)=state.tray_gesture.lock(){gesture.cancel()}},_=>{}
    }
}
fn main() {
    let mut args: Vec<String> = std::env::args().collect();
    // Package startup activation has no ordinary --background CLI parameter.
    #[cfg(windows)] {
        unsafe extern "C" {fn av_package_startup_launch()->bool;}
        if args.len()==1&&unsafe{av_package_startup_launch()}{args.push("--background".into());}
    }
    if args.get(1).map(String::as_str)==Some("--verify-store") {
        unsafe extern "C" {fn av_store_is_packaged()->bool;}
        let result=if unsafe{av_store_is_packaged()}{sharex_service::verify_store_runtime()}else{Err("Run this check from the installed MSIX executable.".into())};
        match result{Ok(editor)=>println!("{}",serde_json::json!({"packaged":true,"editor":editor})),Err(error)=>{println!("{}",serde_json::json!({"ok":false,"error":error}));std::process::exit(1)}};return;
    }
    if args.get(1).map(String::as_str)==Some("--lock-worker") {
        let result=args.get(2).ok_or_else(||"A path is required.".to_string()).and_then(|p|lock_service::worker(std::path::Path::new(p)));
        println!("{}",serde_json::to_string(&result).unwrap());return;
    }
    if args.get(1).map(String::as_str)==Some("--inspect-locks") {
        let result=args.get(2).ok_or_else(||"A path is required.".to_string()).and_then(|p|lock_service::scan(std::path::Path::new(p),&AtomicU64::new(1),1));
        match result{Ok(report)=>println!("{}",serde_json::to_string(&report).unwrap()),Err(error)=>{println!("{}",serde_json::json!({"error":error}));std::process::exit(1)}};return;
    }
    if args.get(1).map(String::as_str)==Some("--inspect-folder") {
        let result=args.get(2).ok_or_else(||"A folder path is required.".to_string()).and_then(|p|directory_service::scan(&PathBuf::from(p),&AtomicU64::new(1),1,|_|{}));
        match result{Ok(snapshot)=>println!("{}",serde_json::to_string(&snapshot.report).unwrap()),Err(error)=>{println!("{}",serde_json::json!({"error":error}));std::process::exit(1)}};return;
    }
    if args.get(1).map(String::as_str)==Some("--inspect-file") {
        let result=args.get(2).ok_or_else(||"A file path is required.".to_string()).and_then(|p|file_service::load(&PathBuf::from(p)).map(|(info,bytes)|serde_json::json!({"ok":true,"info":info,"readBytes":bytes.len()})));
        match result {Ok(value)=>println!("{value}"),Err(error)=>{println!("{}",serde_json::json!({"ok":false,"error":error}));std::process::exit(1)}};return;
    }
    if args.get(1).map(String::as_str)==Some("--diagnose-explorer") {
        let mut path=vec![0u16;32768];let result=unsafe{av_probe(path.as_mut_ptr(),path.len() as i32)};
        let len=path.iter().position(|p|*p==0).unwrap_or(0);
        println!("{}",serde_json::json!({"state":result,"selectedPath":String::from_utf16_lossy(&path[..len])}));return;
    }
    identity::migrate();
    if !unsafe{av_migrate_identity()}{eprintln!("Some previous settings could not be migrated to All View.")}
    let initial_cwd=std::env::current_dir().unwrap_or_default();
    let app=tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("av-media",|context,request,responder|{
            let app=context.app_handle().clone();
            if context.webview_label()!="main"{responder.respond(media_service::empty(403));return}
            let state=app.state::<AppState>();
            if state.media_inflight.fetch_update(Ordering::SeqCst,Ordering::SeqCst,|count|(count<media_service::MAX_INFLIGHT).then_some(count+1)).is_err(){responder.respond(media_service::empty(503));return}
            tauri::async_runtime::spawn_blocking(move||{
                let state=app.state::<AppState>();
                let response=media_response(&state,&request);
                responder.respond(response);
                state.media_inflight.fetch_sub(1,Ordering::SeqCst);
            });
        })
        .plugin(tauri_plugin_single_instance::init(|app,args,cwd|{
            handle_launch(app,&args,std::path::Path::new(&cwd));
        }))
        .plugin(tauri_plugin_dialog::init()).manage(AppState::default())
        .invoke_handler(tauri::generate_handler![current_request,describe_request,read_content,load_preview,open_external,read_pdf_range,prepare_pdf_cache,load_pdf_ocr_cache,save_pdf_ocr_page,fit_preview_window,folder_status,navigate_file,scan_directory,cancel_directory,scan_locks,cancel_locks,release_lock,open_tree_item,open_containing_folder,pick_folder,capture_for_editor,edit_image_native,image_edit_context,save_image,set_tool_interaction,print_preview,pick_file,dismiss_preview,set_pinned,set_header_pinned,get_settings,set_listener_enabled,set_autostart,toggle_fullscreen,quit_app])
        .setup(move |app| {
            APP.set(app.handle().clone()).ok();
            app.state::<AppState>().pinned.store(unsafe{av_get_pin(false)},Ordering::SeqCst);
            app.state::<AppState>().header_pinned.store(unsafe{av_get_pin(true)},Ordering::SeqCst);
            let open=tauri::menu::MenuItem::with_id(app,"open","Open All View",true,None::<&str>)?;
            let settings=tauri::menu::MenuItem::with_id(app,"settings","Settings…",true,None::<&str>)?;
            let enabled=tauri::menu::CheckMenuItem::with_id(app,"space","Space previews in Explorer",true,true,None::<&str>)?;
            let quit=tauri::menu::MenuItem::with_id(app,"quit","Quit All View",true,None::<&str>)?;
            let menu=tauri::menu::Menu::with_items(app,&[&open,&settings,&enabled,&quit])?;
            *app.state::<AppState>().menu.lock().unwrap()=Some(enabled);
            tauri::tray::TrayIconBuilder::with_id("resident").icon(icon()).tooltip("All View · Space to preview")
                .menu(&menu).show_menu_on_left_click(false).on_tray_icon_event(|tray,event|handle_tray_event(tray.app_handle(),event)).on_menu_event(|app,event|match event.id.as_ref(){
                    "open"=>{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}},
                    "settings"=>{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();let _=w.emit("preferences-requested",());}},
                    "space"=>{let next=!app.state::<AppState>().enabled.load(Ordering::SeqCst);enable_listener(app,next)},
                    "quit"=>quit_app(app.clone()), _=>{}
                }).build(app)?;
            if let Some(window)=app.get_webview_window("main"){window.set_icon(icon())?;configure_webview_shortcuts(&window)?;}
            unsafe{av_start(explorer_preview,foreground_changed)};
            // Registration is independent of the first preview and never touches
            // default associations. No-file launches remain hidden throughout.
            tauri::async_runtime::spawn_blocking(register_open_with);
            handle_launch(app.handle(),&args,&initial_cwd);
            Ok(())
        })
        .on_window_event(|window,event| match event {
            tauri::WindowEvent::CloseRequested{api,..}=>{api.prevent_close();hide_preview(window.app_handle(),&window.app_handle().state::<AppState>(),true)},
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop{paths,..})=>{if paths.len()==1{issue_request(window.app_handle(),paths[0].clone(),0)}}, _=>{}
        })
        .build(tauri::generate_context!()).expect("All View could not start");
    app.run(|_,event|{if matches!(event,tauri::RunEvent::Exit){unsafe{av_clear_notification();av_stop()}}});
}

#[cfg(test)] mod activation_tests {
    extern "C" {fn av_test_startup_preferences()->i32;}
    #[test] fn startup_choices_persist_and_change_only_the_owned_fixture_value(){assert_eq!(unsafe{av_test_startup_preferences()},0);}
    extern "C" {fn av_test_desktop_integration()->i32;}
    extern "C" {fn av_test_notification_policy()->i32;fn av_test_runtime_install_policy()->i32;fn av_test_runtime_payload(path:*const u16)->i32;}
    #[test] fn notifications_modify_only_the_resident_tray_and_bound_identity_lookup(){assert_eq!(unsafe{av_test_notification_policy()},0);}
    #[test] fn runtime_setup_rejects_untrusted_bytes_and_validates_optional_official_fixture(){
        use std::os::windows::ffi::OsStrExt;
        let path=std::env::temp_dir().join(format!("av-runtime-invalid-{}.exe",std::process::id()));
        std::fs::write(&path,b"Not an installer").unwrap();
        let wide:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();
        assert_eq!(unsafe{av_test_runtime_payload(wide.as_ptr())},0);std::fs::remove_file(path).unwrap();
        if let Some(path)=std::env::var_os("AV_RUNTIME_INSTALLER_FIXTURE"){
            let wide:Vec<u16>=path.encode_wide().chain(Some(0)).collect();assert_eq!(unsafe{av_test_runtime_payload(wide.as_ptr())},1);
        }
    }
    #[test] fn runtime_setup_distinguishes_missing_framework_and_installer_exit_codes(){assert_eq!(unsafe{av_test_runtime_install_policy()},0);}
    #[test] fn pins_and_open_with_use_isolated_per_user_values_without_default_associations(){assert_eq!(unsafe{av_test_desktop_integration()},0);}
    #[test] fn media_protocol_rejects_stale_ids_and_arbitrary_paths(){
        use super::*;
        let state=AppState::default();
        *state.pending.lock().unwrap()=Some(PreviewRequest{id:9,path:"not-opened.mp4".into(),edit_image:false});
        let request=|uri:&str|tauri::http::Request::builder().uri(uri).body(Vec::new()).unwrap();
        assert_eq!(media_response(&state,&request("http://av-media.localhost/8")).status(),410);
        assert_eq!(media_response(&state,&request("http://av-media.localhost/C:/private.mp4")).status(),404);
        assert_eq!(media_response(&state,&request("http://av-media.localhost/9?path=other")).status(),404);
        assert_eq!(media_response(&state,&request("http://av-media.localhost/9")).status(),404);
        *state.pending.lock().unwrap()=None;
        assert_eq!(media_response(&state,&request("http://av-media.localhost/9")).status(),410);
    }
    extern "C" {fn av_test_space_contract()->bool;}
    #[test] fn first_press_repeats_release_modifiers_and_typing_follow_the_native_contract(){assert!(unsafe{av_test_space_contract()});}
    extern "C" {fn av_test_space_foreground_recovery()->bool;}
    #[test] fn released_space_recovers_on_foreground_change_but_held_space_does_not_repeat(){assert!(unsafe{av_test_space_foreground_recovery()});}
    extern "C" {fn av_test_shell_links(root:*const u16)->i32;fn av_test_shell_ambiguity(root:*const u16)->i32;}
    fn shell_fixture(name:&str,check:unsafe extern "C" fn(*const u16)->i32){
        let root=std::env::temp_dir().join(format!("av-shell-{name}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();let wide:Vec<u16>=root.to_string_lossy().encode_utf16().chain(Some(0)).collect();
        let result=unsafe{check(wide.as_ptr())};std::fs::remove_dir_all(&root).unwrap();assert_eq!(result,0,"native shell fixture failed at case {result}");
    }
    #[test] fn shortcuts_preserve_sources_and_target_policy_is_bounded_without_execution(){shell_fixture("links",av_test_shell_links);}
    #[test] fn ambiguous_shell_display_names_and_exhausted_budgets_never_choose_a_file(){shell_fixture("ambiguity",av_test_shell_ambiguity);}
}
