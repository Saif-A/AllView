#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <string>
#include <cwchar>
#include "package_integration.h"

// A direct shell API call keeps the selected path separate from command text.
// The caller runs this on a worker; initialize an STA for Shell extensions.
extern "C" __declspec(dllexport) int av_open_external(intptr_t owner,const wchar_t* path,bool choose){
    if(!path||!*path)return static_cast<int>(E_INVALIDARG);
    const HRESULT apartment=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(FAILED(apartment))return static_cast<int>(apartment);
    HRESULT result=S_OK;
    if(choose){
        OPENASINFO info{};info.pcszFile=path;info.oaifInFlags=OAIF_EXEC;
        result=SHOpenWithDialog(reinterpret_cast<HWND>(owner),&info);
    }else{
        SHELLEXECUTEINFOW info{};info.cbSize=sizeof(info);info.hwnd=reinterpret_cast<HWND>(owner);
        info.fMask=SEE_MASK_NOASYNC|SEE_MASK_FLAG_NO_UI;info.lpVerb=L"open";info.lpFile=path;info.nShow=SW_SHOWNORMAL;
        if(!ShellExecuteExW(&info)){const DWORD error=GetLastError();result=HRESULT_FROM_WIN32(error?error:ERROR_GEN_FAILURE);}
    }
    CoUninitialize();
    return result==HRESULT_FROM_WIN32(ERROR_CANCELLED)||SUCCEEDED(result)?0:static_cast<int>(result);
}

extern "C" __declspec(dllexport) bool av_control_shortcut(){return (GetKeyState(VK_CONTROL)&0x8000)&&!(GetKeyState(VK_MENU)&0x8000)&&!(GetKeyState(VK_LWIN)&0x8000)&&!(GetKeyState(VK_RWIN)&0x8000);}

// Per-user preferences/association advertisement. Never writes defaults/UserChoice.
static constexpr auto preferences=L"Software\\All View";
static constexpr auto application=L"Software\\Classes\\Applications\\All View.exe";
static constexpr auto startup=L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
// Compatibility names are confined to this one-time identity migration.
static constexpr auto legacy_preferences=L"Software\\quickview++";
static constexpr auto legacy_application=L"Software\\Classes\\Applications\\quickview++.exe";
static bool migrate_preferences(HKEY root,const wchar_t* old_path,const wchar_t* new_path){
    HKEY old{},current{};
    if(RegOpenKeyExW(root,old_path,0,KEY_READ,&old)!=ERROR_SUCCESS)return true;
    if(RegOpenKeyExW(root,new_path,0,KEY_READ,&current)==ERROR_SUCCESS){RegCloseKey(current);RegCloseKey(old);return true;}
    if(RegCreateKeyExW(root,new_path,0,nullptr,0,KEY_ALL_ACCESS,nullptr,&current,nullptr)!=ERROR_SUCCESS){RegCloseKey(old);return false;}
    const auto status=RegCopyTreeW(old,nullptr,current);RegCloseKey(old);RegCloseKey(current);
    return status==ERROR_SUCCESS&&RegDeleteTreeW(root,old_path)==ERROR_SUCCESS;
}
static bool read_pin(HKEY key,const wchar_t* name){
    DWORD value=0,size=sizeof(value),type=0;
    return RegQueryValueExW(key,name,nullptr,&type,reinterpret_cast<BYTE*>(&value),&size)==ERROR_SUCCESS&&type==REG_DWORD&&size==sizeof(value)&&value==1;
}
static bool write_pin(HKEY key,const wchar_t* name,bool value){
    DWORD flag=value?1:0;return RegSetValueExW(key,name,0,REG_DWORD,reinterpret_cast<const BYTE*>(&flag),sizeof(flag))==ERROR_SUCCESS;
}
static bool string_value(HKEY key,const wchar_t* name,const std::wstring& value){
    return RegSetValueExW(key,name,0,REG_SZ,reinterpret_cast<const BYTE*>(value.c_str()),static_cast<DWORD>((value.size()+1)*sizeof(wchar_t)))==ERROR_SUCCESS;
}
static bool same_string(HKEY key,const wchar_t* name,const std::wstring& expected){
    DWORD size=0,type=0;
    if(RegQueryValueExW(key,name,nullptr,&type,nullptr,&size)!=ERROR_SUCCESS||type!=REG_SZ||size!=(expected.size()+1)*sizeof(wchar_t))return false;
    std::wstring value(expected.size()+1,L'\0');
    return RegQueryValueExW(key,name,nullptr,&type,reinterpret_cast<BYTE*>(value.data()),&size)==ERROR_SUCCESS&&value==expected+L'\0';
}
static std::wstring startup_command(){
    wchar_t exe[32768]{};const auto count=GetModuleFileNameW(nullptr,exe,32768);
    return count&&count<32768?L"\""+std::wstring(exe)+L"\" --background":L"";
}
static bool startup_chosen(HKEY prefs,HKEY run,const std::wstring& command){
    // Preserve an opt-in from releases predating the first-run offer.
    return read_pin(prefs,L"StartupChoiceMade")||(!command.empty()&&same_string(run,L"All View",command));
}
static bool write_startup(HKEY prefs,HKEY run,const std::wstring& command,bool enabled){
    // Windows Run commands are limited to 260 characters. Reject before writes.
    if(enabled&&(command.empty()||command.size()>260))return false;
    if(enabled){if(!string_value(run,L"All View",command))return false;}
    else{const auto status=RegDeleteValueW(run,L"All View");if(status!=ERROR_SUCCESS&&status!=ERROR_FILE_NOT_FOUND)return false;}
    return write_pin(prefs,L"StartupChoiceMade",true);
}
static bool register_application(HKEY key,const std::wstring& exe,const std::wstring& extensions,bool& changed){
    const auto command=L"\""+exe+L"\" -- \"%1\"";
    HKEY open{};
    if(RegCreateKeyExW(key,L"shell\\open\\command",0,nullptr,0,KEY_QUERY_VALUE|KEY_SET_VALUE,nullptr,&open,nullptr)!=ERROR_SUCCESS)return false;
    changed=!same_string(open,nullptr,command)||!same_string(key,L"AllViewCatalog",extensions);
    bool ok=true;
    if(changed){
        ok=string_value(key,L"FriendlyAppName",L"All View")&&string_value(key,L"MultiSelectModel",L"Single")&&string_value(open,nullptr,command);
        HKEY supported{};
        if(RegCreateKeyExW(key,L"SupportedTypes",0,nullptr,0,KEY_SET_VALUE,nullptr,&supported,nullptr)!=ERROR_SUCCESS)ok=false;
        else{
            size_t start=0;
            while(start<extensions.size()){
                auto end=extensions.find(L';',start);if(end==std::wstring::npos)end=extensions.size();
                auto extension=extensions.substr(start,end-start);start=end+1;
                if(extension.empty()||extension.size()>32||extension.find_first_not_of(L"abcdefghijklmnopqrstuvwxyz0123456789_+-")!=std::wstring::npos)continue;
                if(!string_value(supported,(L"."+extension).c_str(),L""))ok=false;
            }
            RegCloseKey(supported);
        }
        // Save the marker last, so interrupted/failed registration retries.
        if(ok)ok=string_value(key,L"AllViewCatalog",extensions);
    }
    RegCloseKey(open);return ok;
}

// Modify the resident Tauri tray icon; never add/delete a notification-only icon.
static HWND notification_window=nullptr;
static UINT notification_id=0;
using tray_rect_fn=HRESULT(WINAPI*)(const NOTIFYICONIDENTIFIER*,RECT*);
using tray_notify_fn=BOOL(WINAPI*)(DWORD,PNOTIFYICONDATAW);
static bool resident_icon(HWND window,UINT& id,tray_rect_fn probe=Shell_NotifyIconGetRect){
    NOTIFYICONIDENTIFIER identity{};identity.cbSize=sizeof(identity);identity.hWnd=window;RECT rect{};
    // Pinned tray-icon has a process-local counter. Resolve once through the public
    // Windows API; do not read private dependency structs or another process's data.
    for(UINT candidate=1;candidate<=4096;candidate++){identity.uID=candidate;if(SUCCEEDED(probe(&identity,&rect))){id=candidate;return true;}}
    return false;
}
static bool send_notification(HWND window,UINT id,bool available,const wchar_t* message,bool clear=false,tray_notify_fn send=Shell_NotifyIconW){
    NOTIFYICONDATAW icon{};icon.cbSize=sizeof(icon);icon.hWnd=window;icon.uID=id;icon.uFlags=NIF_INFO;
    if(!clear){wcscpy_s(icon.szInfoTitle,L"All View is running");if(message){wcscpy_s(icon.szInfoTitle,L"All View could not open that request");wcsncpy_s(icon.szInfo,message,_TRUNCATE);}else wcscpy_s(icon.szInfo,available?L"Select a file or folder in Explorer and press Space to preview. Open All View from the tray for more options.":L"Direct file opening is ready. Explorer activation is paused or unavailable; check Settings from the tray.");icon.dwInfoFlags=NIIF_INFO|NIIF_NOSOUND|NIIF_RESPECT_QUIET_TIME;}
    return send(NIM_MODIFY,&icon)!=FALSE;
}
static void clear_notification(){
    if(!notification_window)return;
    if(IsWindow(notification_window))send_notification(notification_window,notification_id,false,nullptr,true);
    notification_window=nullptr;notification_id=0;
}
extern "C" {
__declspec(dllexport) bool av_tray_pointer_down(intptr_t window){
    if(!(GetAsyncKeyState(VK_LBUTTON)&0x8000)&&!(GetAsyncKeyState(VK_RBUTTON)&0x8000))return false;
    POINT point{};if(!GetCursorPos(&point))return false;
    static HWND cached_window=nullptr;static UINT cached_id=0;
    if(cached_window!=(HWND)window||!cached_id){if(!resident_icon((HWND)window,cached_id))return false;cached_window=(HWND)window;}
    NOTIFYICONIDENTIFIER identity{};identity.cbSize=sizeof(identity);identity.hWnd=cached_window;identity.uID=cached_id;RECT rect{};
    if(FAILED(Shell_NotifyIconGetRect(&identity,&rect))){cached_id=0;return false;}
    return PtInRect(&rect,point)!=FALSE;
}
__declspec(dllexport) bool av_migrate_identity(){
    bool ok=migrate_preferences(HKEY_CURRENT_USER,legacy_preferences,preferences);
    // Package startup belongs to StartupTask, including during legacy migration.
    if(av_has_package_identity())return ok;
    HKEY run{};if(RegOpenKeyExW(HKEY_CURRENT_USER,startup,0,KEY_QUERY_VALUE|KEY_SET_VALUE,&run)==ERROR_SUCCESS){
        DWORD type=0,size=0;const auto present=RegQueryValueExW(run,L"All View",nullptr,&type,nullptr,&size)==ERROR_SUCCESS;
        if(!present&&RegQueryValueExW(run,L"quickview++",nullptr,&type,nullptr,&size)==ERROR_SUCCESS&&type==REG_SZ&&size>2&&size<=522){
            std::wstring legacy(size/sizeof(wchar_t),L'\0');
            if(RegQueryValueExW(run,L"quickview++",nullptr,&type,reinterpret_cast<BYTE*>(legacy.data()),&size)==ERROR_SUCCESS){
                const auto suffix=L"\\quickview++.exe\" --background";while(!legacy.empty()&&legacy.back()==L'\0')legacy.pop_back();const auto command=startup_command();
                if(legacy.size()>wcslen(suffix)&&legacy.front()==L'\"'&&legacy.compare(legacy.size()-wcslen(suffix),wcslen(suffix),suffix)==0&&!command.empty()&&command.size()<=260){
                    if(string_value(run,L"All View",command))ok=(RegDeleteValueW(run,L"quickview++")==ERROR_SUCCESS)&&ok;else ok=false;
                }
            }
        }RegCloseKey(run);
    }return ok;
}
__declspec(dllexport) bool av_autostart_enabled(){
    if(av_has_package_identity())return av_package_startup_enabled();
    HKEY key{};if(RegOpenKeyExW(HKEY_CURRENT_USER,startup,0,KEY_QUERY_VALUE,&key)!=ERROR_SUCCESS)return false;
    const auto command=startup_command();const bool enabled=!command.empty()&&same_string(key,L"All View",command);RegCloseKey(key);return enabled;
}
__declspec(dllexport) bool av_startup_choice_made(){
    if(av_has_package_identity()){
        HKEY key{};if(RegOpenKeyExW(HKEY_CURRENT_USER,preferences,0,KEY_QUERY_VALUE,&key)!=ERROR_SUCCESS)return av_package_startup_enabled();
        const bool chosen=read_pin(key,L"StoreStartupChoiceMade");RegCloseKey(key);return chosen||av_package_startup_enabled();
    }
    HKEY prefs{},run{};RegOpenKeyExW(HKEY_CURRENT_USER,preferences,0,KEY_QUERY_VALUE,&prefs);RegOpenKeyExW(HKEY_CURRENT_USER,startup,0,KEY_QUERY_VALUE,&run);
    const bool chosen=startup_chosen(prefs,run,startup_command());if(prefs)RegCloseKey(prefs);if(run)RegCloseKey(run);return chosen;
}
__declspec(dllexport) bool av_set_autostart(bool enabled){
    if(av_has_package_identity()){
        if(!av_package_set_startup(enabled))return false;
        HKEY key{};if(RegCreateKeyExW(HKEY_CURRENT_USER,preferences,0,nullptr,0,KEY_SET_VALUE,nullptr,&key,nullptr)!=ERROR_SUCCESS)return false;
        const bool ok=write_pin(key,L"StoreStartupChoiceMade",true);RegCloseKey(key);return ok;
    }
    const auto command=startup_command();if(enabled&&(command.empty()||command.size()>260))return false;
    HKEY prefs{},run{};
    if(RegCreateKeyExW(HKEY_CURRENT_USER,preferences,0,nullptr,0,KEY_SET_VALUE,nullptr,&prefs,nullptr)!=ERROR_SUCCESS)return false;
    if(RegCreateKeyExW(HKEY_CURRENT_USER,startup,0,nullptr,0,KEY_SET_VALUE,nullptr,&run,nullptr)!=ERROR_SUCCESS){RegCloseKey(prefs);return false;}
    const bool ok=write_startup(prefs,run,command,enabled);RegCloseKey(run);RegCloseKey(prefs);return ok;
}
__declspec(dllexport) bool av_get_pin(bool header){
    HKEY key{};if(RegOpenKeyExW(HKEY_CURRENT_USER,preferences,0,KEY_QUERY_VALUE,&key)!=ERROR_SUCCESS)return false;
    const bool value=read_pin(key,header?L"HeaderPinned":L"WindowPinned");RegCloseKey(key);return value;
}
__declspec(dllexport) bool av_save_pin(bool header,bool pinned){
    HKEY key{};if(RegCreateKeyExW(HKEY_CURRENT_USER,preferences,0,nullptr,0,KEY_SET_VALUE,nullptr,&key,nullptr)!=ERROR_SUCCESS)return false;
    const bool ok=write_pin(key,header?L"HeaderPinned":L"WindowPinned",pinned);RegCloseKey(key);return ok;
}
__declspec(dllexport) bool av_register_open_with(const wchar_t* extensions){
    // MSIX declares these in its manifest; package upgrades/uninstall own them.
    if(av_has_package_identity())return true;
    if(!extensions)return false;
    wchar_t path[32768]{};const DWORD count=GetModuleFileNameW(nullptr,path,32768);
    if(!count||count>=32768)return false;
    const auto name=wcsrchr(path,L'\\');if(!name||_wcsicmp(name+1,L"All View.exe"))return true;
    HKEY key{};if(RegCreateKeyExW(HKEY_CURRENT_USER,application,0,nullptr,0,KEY_QUERY_VALUE|KEY_SET_VALUE|KEY_CREATE_SUB_KEY,nullptr,&key,nullptr)!=ERROR_SUCCESS)return false;
    bool changed=false;const bool ok=register_application(key,path,extensions,changed);RegCloseKey(key);
    // Keep a hidden compatibility alias for existing Windows UserChoice records.
    // Its display name/command point to All View; never alter hashed defaults.
    if(ok&&RegOpenKeyExW(HKEY_CURRENT_USER,legacy_application,0,KEY_QUERY_VALUE|KEY_SET_VALUE|KEY_CREATE_SUB_KEY,&key)==ERROR_SUCCESS){
        DWORD type=0,size=0;if(RegQueryValueExW(key,L"QuickviewCatalog",nullptr,&type,nullptr,&size)==ERROR_SUCCESS&&type==REG_SZ){bool legacy_changed=false;register_application(key,path,extensions,legacy_changed);string_value(key,L"NoOpenWith",L"");}RegCloseKey(key);
    }
    if(ok&&changed)SHChangeNotify(SHCNE_ASSOCCHANGED,SHCNF_IDLIST,nullptr,nullptr);
    return ok;
}
__declspec(dllexport) bool av_notify_started(intptr_t window,bool available,const wchar_t* message){
    auto target=reinterpret_cast<HWND>(window);DWORD process=0;if(!IsWindow(target)||!GetWindowThreadProcessId(target,&process)||process!=GetCurrentProcessId())return false;
    if(notification_window!=target||!notification_id){UINT id=0;if(!resident_icon(target,id))return false;notification_window=target;notification_id=id;}
    return send_notification(target,notification_id,available,message);
}
__declspec(dllexport) void av_clear_notification(){clear_notification();}

#ifdef AV_INPUT_TESTS
__declspec(dllexport) int av_test_startup_preferences(){
    const auto path=L"Software\\All View-startup-test-"+std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(GetTickCount64());
    HKEY root{},prefs{},run{};DWORD disposition=0;
    if(RegCreateKeyExW(HKEY_CURRENT_USER,path.c_str(),0,nullptr,0,KEY_ALL_ACCESS,nullptr,&root,&disposition)!=ERROR_SUCCESS)return 1;
    if(disposition!=REG_CREATED_NEW_KEY){RegCloseKey(root);return 2;}
    int result=0;const std::wstring command=L"\"C:\\Program files\\معاينة\\All View.exe\" --background";
    do{
        if(RegCreateKeyExW(root,L"Preferences",0,nullptr,0,KEY_ALL_ACCESS,nullptr,&prefs,nullptr)!=ERROR_SUCCESS||RegCreateKeyExW(root,L"Run",0,nullptr,0,KEY_ALL_ACCESS,nullptr,&run,nullptr)!=ERROR_SUCCESS){result=3;break;}
        if(startup_chosen(prefs,run,command)){result=4;break;}
        if(!string_value(run,L"Other app",L"preserve")){result=5;break;}
        if(write_startup(prefs,run,std::wstring(261,L'x'),true)||startup_chosen(prefs,run,command)){result=6;break;}
        // A denied write must not mark an unanswered offer complete.
        HKEY readonly{};RegOpenKeyExW(root,L"Run",0,KEY_READ,&readonly);
        const bool denied=write_startup(prefs,readonly,command,true);if(readonly)RegCloseKey(readonly);
        if(denied||startup_chosen(prefs,run,command)){result=7;break;}
        if(!write_startup(prefs,run,command,false)||!startup_chosen(prefs,run,command)||same_string(run,L"All View",command)){result=8;break;}
        if(!write_startup(prefs,run,command,true)||!same_string(run,L"All View",command)){result=9;break;}
        RegCloseKey(prefs);prefs=nullptr;RegCloseKey(run);run=nullptr;
        if(RegOpenKeyExW(root,L"Preferences",0,KEY_ALL_ACCESS,&prefs)!=ERROR_SUCCESS||RegOpenKeyExW(root,L"Run",0,KEY_ALL_ACCESS,&run)!=ERROR_SUCCESS||!startup_chosen(prefs,run,command)||!same_string(run,L"All View",command)){result=10;break;}
        if(!write_pin(prefs,L"StartupChoiceMade",false)||!startup_chosen(prefs,run,command)){result=11;break;}
        if(!write_startup(prefs,run,command,false)||!write_startup(prefs,run,command,false)||!same_string(run,L"Other app",L"preserve")){result=12;break;}
        if(!write_pin(prefs,L"StartupChoiceMade",false)||!string_value(run,L"All View",L"wrong command")||startup_chosen(prefs,run,command)){result=13;break;}
    }while(false);
    if(run)RegCloseKey(run);if(prefs)RegCloseKey(prefs);RegCloseKey(root);RegDeleteTreeW(HKEY_CURRENT_USER,path.c_str());return result;
}
static UINT fixture_rect_calls=0,fixture_notify_calls=0;static bool fixture_found=true,fixture_valid=true;
static HRESULT WINAPI fixture_rect(const NOTIFYICONIDENTIFIER* identity,RECT*){fixture_rect_calls++;return fixture_found&&identity->uID==7?S_OK:E_FAIL;}
static BOOL WINAPI fixture_notify(DWORD action,PNOTIFYICONDATAW data){fixture_notify_calls++;fixture_valid=fixture_valid&&action==NIM_MODIFY&&data->uID==7&&data->uFlags==NIF_INFO&&!data->hIcon&&data->hWnd==reinterpret_cast<HWND>(1);return TRUE;}
__declspec(dllexport) int av_test_notification_policy(){
    UINT id=0;fixture_rect_calls=fixture_notify_calls=0;fixture_found=fixture_valid=true;
    if(!resident_icon(reinterpret_cast<HWND>(1),id,fixture_rect)||id!=7||fixture_rect_calls!=7)return 1;
    if(!send_notification(reinterpret_cast<HWND>(1),id,true,nullptr,false,fixture_notify)||!send_notification(reinterpret_cast<HWND>(1),id,false,L"Fixture error",false,fixture_notify)||!send_notification(reinterpret_cast<HWND>(1),id,false,nullptr,true,fixture_notify)||fixture_notify_calls!=3||!fixture_valid)return 2;
    fixture_rect_calls=0;fixture_found=false;if(resident_icon(reinterpret_cast<HWND>(1),id,fixture_rect)||fixture_rect_calls!=4096)return 3;
    return 0;
}
__declspec(dllexport) int av_test_desktop_integration(){
    const auto path=L"Software\\All View-test-"+std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(GetTickCount64());
    HKEY key{};DWORD disposition=0;
    if(RegCreateKeyExW(HKEY_CURRENT_USER,path.c_str(),0,nullptr,0,KEY_ALL_ACCESS,nullptr,&key,&disposition)!=ERROR_SUCCESS)return 1;
    if(disposition!=REG_CREATED_NEW_KEY){RegCloseKey(key);return 2;}
    int result=0;
    do{
        HKEY old{},current{};RegCreateKeyExW(key,L"Old",0,nullptr,0,KEY_ALL_ACCESS,nullptr,&old,nullptr);write_pin(old,L"HeaderPinned",true);RegCloseKey(old);
        if(!migrate_preferences(key,L"Old",L"New")||RegOpenKeyExW(key,L"New",0,KEY_READ,&current)!=ERROR_SUCCESS){result=15;break;}
        const bool migrated=read_pin(current,L"HeaderPinned");RegCloseKey(current);if(!migrated||RegOpenKeyExW(key,L"Old",0,KEY_READ,&old)==ERROR_SUCCESS){if(old)RegCloseKey(old);result=16;break;}
        RegCreateKeyExW(key,L"Old",0,nullptr,0,KEY_ALL_ACCESS,nullptr,&old,nullptr);write_pin(old,L"HeaderPinned",false);RegCloseKey(old);
        if(!migrate_preferences(key,L"Old",L"New")||RegOpenKeyExW(key,L"New",0,KEY_READ,&current)!=ERROR_SUCCESS){result=17;break;}const bool retained=read_pin(current,L"HeaderPinned");RegCloseKey(current);if(!retained){result=18;break;}
        if(read_pin(key,L"HeaderPinned")||read_pin(key,L"WindowPinned")){result=3;break;}
        if(!write_pin(key,L"HeaderPinned",true)||!read_pin(key,L"HeaderPinned")||read_pin(key,L"WindowPinned")){result=4;break;}
        if(!write_pin(key,L"WindowPinned",true)||!write_pin(key,L"HeaderPinned",false)||!read_pin(key,L"WindowPinned")||read_pin(key,L"HeaderPinned")){result=5;break;}
        RegCloseKey(key);key=nullptr;
        if(RegOpenKeyExW(HKEY_CURRENT_USER,path.c_str(),0,KEY_ALL_ACCESS,&key)!=ERROR_SUCCESS){result=13;break;}
        if(!read_pin(key,L"WindowPinned")||read_pin(key,L"HeaderPinned")){result=14;break;}
        if(!string_value(key,L"HeaderPinned",L"true")||read_pin(key,L"HeaderPinned")){result=6;break;}
        DWORD invalid=2;RegSetValueExW(key,L"WindowPinned",0,REG_DWORD,reinterpret_cast<BYTE*>(&invalid),sizeof(invalid));
        if(read_pin(key,L"WindowPinned")){result=7;break;}
        bool changed=false;
        if(!register_application(key,L"C:\\Program files\\All View.exe",L"mp4;txt;jpg",changed)||!changed){result=8;break;}
        HKEY command{};
        if(RegOpenKeyExW(key,L"shell\\open\\command",0,KEY_QUERY_VALUE,&command)!=ERROR_SUCCESS){result=9;break;}
        const bool quoted=same_string(command,nullptr,L"\"C:\\Program files\\All View.exe\" -- \"%1\"");RegCloseKey(command);
        if(!quoted){result=10;break;}
        if(!register_application(key,L"C:\\Program files\\All View.exe",L"mp4;txt;jpg",changed)||changed){result=11;break;}
        if(!register_application(key,L"D:\\Moved\\All View.exe",L"mp4;txt;jpg;png",changed)||!changed){result=12;break;}
    }while(false);
    if(key)RegCloseKey(key);RegDeleteTreeW(HKEY_CURRENT_USER,path.c_str());return result;
}
#endif
}
