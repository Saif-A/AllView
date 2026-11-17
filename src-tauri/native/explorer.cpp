#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <servprov.h>
#include <exdisp.h>
#include <shobjidl.h>
#include <shlguid.h>
#include <atomic>
#include <string>
#include <cwchar>
#include "space_gate.h"
#include "com_ptr.h"
#include "shell_selection.h"

// No process injection or keyboard logging. A bounded hook filters only Space;
// shell COM work runs on a separate STA. Selection/focus is rechecked there.
using PreviewCallback = void (__cdecl *)(const wchar_t*, intptr_t);
using ForegroundCallback = void (__cdecl *)();
static PreviewCallback callback = nullptr;
static ForegroundCallback foreground_callback = nullptr;
static std::atomic<bool> enabled{true}, running{false}, queued{false};
static std::atomic<HWND> requested_window{nullptr};
static std::atomic<HWND> origin_focus{nullptr};
static std::atomic<DWORD> worker_id{0}, hook_id{0};
static HANDLE worker_handle = nullptr, hook_handle = nullptr, ready_event = nullptr, worker_ready = nullptr;
static HHOOK keyboard_hook = nullptr;
static SpaceGate space_gate;
static constexpr UINT RESOLVE = WM_APP + 41;

static bool class_is(HWND window, const wchar_t* name) {
    wchar_t value[128]{};
    return GetClassNameW(window, value, 128) && _wcsicmp(value, name) == 0;
}
static bool explorer_file_focus(HWND window) {
    if (!window || !class_is(window, L"CabinetWClass")) return false;
    GUITHREADINFO info{sizeof(info)};
    if (!GetGUIThreadInfo(GetWindowThreadProcessId(window, nullptr), &info)) return false;
    if (!info.hwndFocus || info.hwndCaret || (info.flags & (GUI_INMENUMODE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE))) return false;
    HWND node = info.hwndFocus;
    bool list = false;
    for (int depth = 0; node && depth < 16; ++depth, node = GetParent(node)) {
        wchar_t name[128]{};
        GetClassNameW(node, name, 128);
        if (wcsstr(name, L"Edit") || wcsstr(name, L"edit") || wcsstr(name, L"TextBox")) return false;
        if (_wcsicmp(name, L"DirectUIHWND") == 0 || _wcsicmp(name, L"SysListView32") == 0) list = true;
        if (_wcsicmp(name, L"SHELLDLL_DefView") == 0) return list;
        if (node == window) break;
    }
    return false;
}
static std::wstring registered_selection(HWND window,const GUITHREADINFO& focus,IShellWindows* existing) {
    Com<IShellWindows> shell;
    if (!existing && FAILED(CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(shell.out())))) return {};
    IShellWindows* windows = existing ? existing : shell.p;
    long count = 0;
    if (FAILED(windows->get_Count(&count))) return {};
    for (long i = 0; i < count; ++i) {
        VARIANT index{}; index.vt = VT_I4; index.lVal = i;
        Com<IDispatch> dispatch;
        if (FAILED(windows->Item(index, dispatch.out())) || !dispatch) continue;
        Com<IServiceProvider> service;
        Com<IShellBrowser> shell_browser;
        Com<IShellView> view;
        if (FAILED(dispatch->QueryInterface(IID_PPV_ARGS(service.out()))) ||
            FAILED(service->QueryService(SID_SShellBrowser, IID_PPV_ARGS(shell_browser.out())))) continue;
        HWND browser_window=nullptr;
        if(FAILED(shell_browser->GetWindow(&browser_window))||!IsWindowVisible(browser_window)||GetAncestor(browser_window,GA_ROOT)!=window||
            FAILED(shell_browser->QueryActiveShellView(view.out())))continue;
        HWND view_window = nullptr;
        if (FAILED(view->GetWindow(&view_window)) || !IsWindowVisible(view_window) ||
            !(view_window == focus.hwndFocus || IsChild(view_window, focus.hwndFocus))) continue;
        Com<IFolderView2> folder;
        Com<IShellItemArray> items;
        if (FAILED(view->QueryInterface(IID_PPV_ARGS(folder.out()))) || FAILED(folder->GetSelection(FALSE, items.out()))) continue;
        DWORD selected = 0;
        if (FAILED(items->GetCount(&selected)) || selected != 1) return {};
        Com<IShellItem> item;
        if (FAILED(items->GetItemAt(0, item.out()))) return {};
        SFGAOF attributes = 0;
        if (FAILED(item->GetAttributes(SFGAO_FILESYSTEM | SFGAO_FOLDER, &attributes)) ||
            !(attributes & SFGAO_FILESYSTEM)) return {};
        PWSTR path = nullptr;
        if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) return {};
        std::wstring result(path); CoTaskMemFree(path);
        return result;
    }
    return {};
}
static std::wstring selected_file(HWND window, Com<IShellWindows>* existing = nullptr) {
    if(window!=GetForegroundWindow()||!explorer_file_focus(window))return {};
    GUITHREADINFO focus{sizeof(focus)};
    if(!GetGUIThreadInfo(GetWindowThreadProcessId(window,nullptr),&focus))return {};
    auto path=registered_selection(window,focus,existing?existing->p:nullptr);
    if(path.empty()&&existing&&window==GetForegroundWindow()&&explorer_file_focus(window)){
        CoCreateInstance(CLSID_ShellWindows,nullptr,CLSCTX_LOCAL_SERVER,IID_PPV_ARGS(existing->out()));
        path=registered_selection(window,focus,existing->p);
    }
    if(path.empty())path=breadcrumb_selection(window,focus.hwndFocus);
    if(window!=GetForegroundWindow()||!explorer_file_focus(window))return {};
    return preview_link_target(path);
}
static bool queue_resolve(HWND window) {
    DWORD thread = worker_id.load();
    if (!thread) return false;
    requested_window.store(window);
    if (!queued.exchange(true) && !PostThreadMessageW(thread, RESOLVE, 0, 0)) {
        queued.store(false); return false;
    }
    return true;
}
static DWORD WINAPI selection_thread(void*) {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    MSG msg{}; PeekMessageW(&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    worker_id.store(GetCurrentThreadId());
    SetEvent(worker_ready);
    // Reuse this apartment-owned Shell collection. No selection polling occurs
    // on focus/selection notifications from Explorer or unrelated applications.
    Com<IShellWindows> shell;
    CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(shell.out()));
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        if (msg.message != RESOLVE) { TranslateMessage(&msg); DispatchMessageW(&msg); continue; }
        queued.store(false);
        HWND window = requested_window.load();
        if (!enabled.load() || window != GetForegroundWindow() || !explorer_file_focus(window)) continue;
        if (!shell) CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(shell.out()));
        // Refresh a disconnected collection once before trying the bounded
        // orphan-window fallback. Never repeat a full fallback for one press.
        auto path = selected_file(window, &shell);
        if (enabled.load() && !path.empty() && window == GetForegroundWindow() && explorer_file_focus(window) && callback) {
            GUITHREADINFO focus{sizeof(focus)};
            if (GetGUIThreadInfo(GetWindowThreadProcessId(window, nullptr), &focus)) origin_focus.store(focus.hwndFocus);
            callback(path.c_str(), (intptr_t)window);
        }
    }
    shell.out(); // release on this STA before uninitializing COM
    worker_id.store(0); CoUninitialize(); return 0;
}
static void CALLBACK selection_event(HWINEVENTHOOK, DWORD event, HWND, LONG, LONG, DWORD, DWORD) {
    // Runs on the hook's message thread, outside LowLevelKeyboardProc. Recover
    // a missed key-up without rearming an actually held Space or doing Shell IO.
    if (event == EVENT_SYSTEM_FOREGROUND) {
        space_gate.foreground((GetAsyncKeyState(VK_SPACE) & 0x8000) != 0);
        if (foreground_callback) foreground_callback();
    }
}
static LRESULT CALLBACK keyboard(int code, WPARAM kind, LPARAM data) {
    if (code < 0) return CallNextHookEx(keyboard_hook, code, kind, data);
    auto key = reinterpret_cast<KBDLLHOOKSTRUCT*>(data);
    if (key->vkCode != VK_SPACE) return CallNextHookEx(keyboard_hook, code, kind, data);
    if (kind == WM_KEYUP || kind == WM_SYSKEYUP) {
        if (space_gate.up()) return 1;
        return CallNextHookEx(keyboard_hook, code, kind, data);
    }
    if (kind != WM_KEYDOWN) return CallNextHookEx(keyboard_hook, code, kind, data);
    bool modified = (GetAsyncKeyState(VK_CONTROL) & 0x8000) || (GetAsyncKeyState(VK_MENU) & 0x8000) ||
        (GetAsyncKeyState(VK_SHIFT) & 0x8000) || (GetAsyncKeyState(VK_LWIN) & 0x8000) || (GetAsyncKeyState(VK_RWIN) & 0x8000);
    if (!enabled.load() || modified)
        return CallNextHookEx(keyboard_hook, code, kind, data);
    HWND window = GetForegroundWindow();
    auto decision = space_gate.down(SpaceGate::eligible(true, false, explorer_file_focus(window)));
    if (decision.resolve && !queue_resolve(window)) {
        space_gate.cancel(); return CallNextHookEx(keyboard_hook, code, kind, data);
    }
    if (decision.consume) return 1;
    return CallNextHookEx(keyboard_hook, code, kind, data);
}
static DWORD WINAPI input_thread(void*) {
    hook_id.store(GetCurrentThreadId());
    MSG msg{}; PeekMessageW(&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard, GetModuleHandleW(nullptr), 0);
    auto foreground_hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, selection_event, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    running.store(keyboard_hook != nullptr); SetEvent(ready_event);
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
    if (foreground_hook) UnhookWinEvent(foreground_hook);
    if (keyboard_hook) UnhookWindowsHookEx(keyboard_hook);
    running.store(false); hook_id.store(0); return 0;
}
extern "C" {
__declspec(dllexport) bool av_start(PreviewCallback fn, ForegroundCallback focus_fn) {
    callback = fn;
    foreground_callback = focus_fn;
    ready_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    worker_ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    worker_handle = CreateThread(nullptr, 0, selection_thread, nullptr, 0, nullptr);
    // Input cannot be accepted before the resolver's message queue exists.
    if (!worker_handle || WaitForSingleObject(worker_ready, 3000) != WAIT_OBJECT_0) return false;
    hook_handle = CreateThread(nullptr, 0, input_thread, nullptr, 0, nullptr);
    WaitForSingleObject(ready_event, 3000);
    return running.load();
}
__declspec(dllexport) void av_set_enabled(bool value) { enabled.store(value); }
__declspec(dllexport) bool av_running() { return running.load(); }
__declspec(dllexport) bool av_has_foreground(intptr_t window) { return GetForegroundWindow() == (HWND)window; }
__declspec(dllexport) void av_restore(intptr_t value) {
    HWND window = (HWND)value;
    HWND focus = origin_focus.exchange(nullptr);
    if (!IsWindow(window)) return;
    SetForegroundWindow(window);
    if (!IsWindow(focus) || !IsWindowVisible(focus) || !IsChild(window, focus)) return;
    DWORD own = GetCurrentThreadId(), target = GetWindowThreadProcessId(focus, nullptr);
    // Restore the exact originating file list, then immediately detach queues.
    bool attached = own != target && AttachThreadInput(own, target, TRUE);
    if (own == target || attached) SetFocus(focus);
    if (attached) AttachThreadInput(own, target, FALSE);
}
__declspec(dllexport) void av_stop() {
    enabled.store(false);
    if (hook_id.load()) PostThreadMessageW(hook_id.load(), WM_QUIT, 0, 0);
    if (worker_id.load()) PostThreadMessageW(worker_id.load(), WM_QUIT, 0, 0);
    for (auto handle : {hook_handle, worker_handle}) if (handle) { WaitForSingleObject(handle, 2000); CloseHandle(handle); }
    hook_handle = nullptr; worker_handle = nullptr;
    if (ready_event) { CloseHandle(ready_event); ready_event = nullptr; }
    if (worker_ready) { CloseHandle(worker_ready); worker_ready = nullptr; }
}
#ifdef AV_INPUT_TESTS
__declspec(dllexport) bool av_test_space_contract() {
    SpaceGate gate;
    // A first eligible press consumes immediately with no selection cache.
    auto first = gate.down(SpaceGate::eligible(true, false, true));
    if (!first.consume || !first.resolve) return false;
    for (int i = 0; i < 100; ++i) { auto repeat = gate.down(true); if (!repeat.consume || repeat.resolve) return false; }
    // Showing a preview changes foreground focus while Space may still be held;
    // that same press must not leak repeats into media or another app.
    auto moved = gate.down(false); if (!moved.consume || moved.resolve) return false;
    if (!gate.up() || gate.up()) return false;
    auto second = gate.down(true); if (!second.consume || !second.resolve) return false;
    gate.cancel(); if (gate.up()) return false;
    // Disabled, modified and editable/non-file-list focus remain untouched.
    for (auto allowed : {SpaceGate::eligible(false,false,true), SpaceGate::eligible(true,true,true), SpaceGate::eligible(true,false,false)}) {
        auto ignored = gate.down(allowed); if (ignored.consume || ignored.resolve || gate.up()) return false;
    }
    return true;
}
__declspec(dllexport) bool av_test_space_foreground_recovery() {
    SpaceGate gate;
    auto first=gate.down(true);
    if (!first.consume || !first.resolve) return false;
    // Focus moves while the physical key is held: never reopen or leak repeats.
    gate.foreground(true);
    auto held=gate.down(true);
    if (!held.consume || held.resolve || !gate.up()) return false;
    // Simulate a missing key-up after activation, then click another file.
    gate.down(true);
    gate.foreground(false);
    auto next=gate.down(true);
    if (!next.consume || !next.resolve || !gate.up()) return false;
    // A foreground change must not authorize editable/modified Space.
    gate.down(true);gate.foreground(false);
    auto typing=gate.down(false);
    if (typing.consume || typing.resolve || gate.up()) return false;
    // Repeated blur/open cycles each get a first press, without warming selection.
    for (int i=0;i<100;++i) {
        gate.foreground(false);auto press=gate.down(true);
        if (!press.consume || !press.resolve) return false;
    }
    return true;
}
#endif
__declspec(dllexport) int av_probe(wchar_t* buffer, int size) {
    HWND window = GetForegroundWindow();
    if (!class_is(window, L"CabinetWClass")) return 0;
    if (!explorer_file_focus(window)) return 1;
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    auto path = selected_file(window);
    CoUninitialize();
    if (path.empty()) return 2;
    if (buffer && size > 0) wcsncpy_s(buffer, size, path.c_str(), _TRUNCATE);
    return 3;
}
}
