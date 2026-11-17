// Windows usage inspection. Called only in the disposable --lock-worker process.
// No foreign handles are closed; DuplicateHandle copies are owned by this process.
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <psapi.h>
#include <map>
#include <set>
#include <string>
#include <vector>
#include <algorithm>
#include <cstdint>
#include <cstddef>
#include <memory>
#include <mutex>
#include <thread>
#include <optional>

namespace {
using QuerySystem = NTSTATUS(NTAPI*)(ULONG, PVOID, ULONG, PULONG);
using QueryObject = NTSTATUS(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
struct HandleEntry {
    PVOID object; ULONG_PTR pid, value; ULONG access; USHORT backtrace, type; ULONG attributes, reserved;
};
struct HandleTable { ULONG_PTR count, reserved; HandleEntry entries[1]; };
struct Owned {
    HANDLE value=nullptr;
    explicit Owned(HANDLE h=nullptr):value(h){}
    ~Owned(){if(value && value!=INVALID_HANDLE_VALUE)CloseHandle(value);}
    Owned(const Owned&)=delete;Owned& operator=(const Owned&)=delete;
    explicit operator bool()const{return value && value!=INVALID_HANDLE_VALUE;}
};
using Match = void(*)(void*, DWORD, uint64_t, const wchar_t*, const wchar_t*, const wchar_t*);
uint64_t time_value(FILETIME t){return (uint64_t(t.dwHighDateTime)<<32)|t.dwLowDateTime;}
uint64_t birth(HANDLE h){FILETIME c,e,k,u;return GetProcessTimes(h,&c,&e,&k,&u)?time_value(c):0;}
std::wstring image(HANDLE h){std::wstring s(32768,L'\0');DWORD n=DWORD(s.size());if(!QueryFullProcessImageNameW(h,0,s.data(),&n))return {};s.resize(n);return s;}
bool same(const std::wstring&a,const std::wstring&b){return CompareStringOrdinal(a.c_str(),int(a.size()),b.c_str(),int(b.size()),TRUE)==CSTR_EQUAL;}
bool within(const std::wstring&path,const std::wstring&root,bool directory){
    if(same(path,root))return true;
    return directory && path.size()>root.size() && path[root.size()]==L'\\' &&
        CompareStringOrdinal(path.c_str(),int(root.size()),root.c_str(),int(root.size()),TRUE)==CSTR_EQUAL;
}
std::wstring object_name(QueryObject query,HANDLE file){
    std::vector<BYTE> bytes(65536);ULONG used=0;
    if(query(file,1,bytes.data(),ULONG(bytes.size()),&used)<0)return {};
    auto s=reinterpret_cast<UNICODE_STRING*>(bytes.data());
    auto start=reinterpret_cast<uintptr_t>(s->Buffer),base=reinterpret_cast<uintptr_t>(bytes.data());
    if(s->Length%2 || start<base || start+s->Length>base+bytes.size())return {};
    return {s->Buffer,size_t(s->Length/sizeof(wchar_t))};
}
// Some synchronous handles block even GetFileType/NtQueryObject. A stalled
// query owns its copied handle/state until completion, never caller stack data.
// At most eight abandoned threads exist, only inside this disposable helper.
class NameWorker {
    struct State {
        Owned request{CreateEventW(nullptr,FALSE,FALSE,nullptr)},done{CreateEventW(nullptr,FALSE,FALSE,nullptr)};
        std::mutex mutex;HANDLE input=nullptr;bool stop=false;std::wstring result;QueryObject names;
        explicit State(QueryObject query):names(query){}
    };
    std::shared_ptr<State> state;
public:
    explicit NameWorker(QueryObject query):state(std::make_shared<State>(query)){
        auto s=state;if(!s->request||!s->done)throw std::bad_alloc();
        std::thread([s]{
            for(;;){
                WaitForSingleObject(s->request.value,INFINITE);
                HANDLE h;bool stop;
                {std::lock_guard<std::mutex> lock(s->mutex);h=s->input;s->input=nullptr;stop=s->stop;}
                Owned input(h);if(stop)return;
                auto name=GetFileType(h)==FILE_TYPE_DISK?object_name(s->names,h):std::wstring();
                {std::lock_guard<std::mutex> lock(s->mutex);s->result=std::move(name);}
                SetEvent(s->done.value);
            }
        }).detach();
    }
    ~NameWorker(){std::lock_guard<std::mutex> lock(state->mutex);state->stop=true;SetEvent(state->request.value);}
    std::optional<std::wstring> query(HANDLE owned){
        {std::lock_guard<std::mutex> lock(state->mutex);state->input=owned;}
        SetEvent(state->request.value);
        if(WaitForSingleObject(state->done.value,50)!=WAIT_OBJECT_0)return std::nullopt;
        std::lock_guard<std::mutex> lock(state->mutex);return std::move(state->result);
    }
};
bool same_user(HANDLE process){
    HANDLE a=nullptr,b=nullptr;
    if(!OpenProcessToken(process,TOKEN_QUERY,&a))return false;Owned first(a);
    if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&b))return false;Owned second(b);
    auto token=[](HANDLE h){DWORD n=0;GetTokenInformation(h,TokenUser,nullptr,0,&n);std::vector<BYTE> v(n);if(!n||!GetTokenInformation(h,TokenUser,v.data(),n,&n))v.clear();return v;};
    auto x=token(a),y=token(b);return !x.empty()&&!y.empty()&&EqualSid(reinterpret_cast<TOKEN_USER*>(x.data())->User.Sid,reinterpret_cast<TOKEN_USER*>(y.data())->User.Sid);
}
std::wstring protected_reason(HANDLE process,DWORD pid,const std::wstring&exe){
    if(pid<=4 || pid==GetCurrentProcessId())return L"System or All View process";
    if(exe.empty())return L"Process identity unavailable";
    DWORD session=0,ours=0;BOOL critical=FALSE;
    if(!ProcessIdToSessionId(pid,&session)||!ProcessIdToSessionId(GetCurrentProcessId(),&ours)||session!=ours||!same_user(process))return L"Another user or Windows session";
    if(!IsProcessCritical(process,&critical)||critical)return L"Critical or protected process";
    wchar_t windows[32768];UINT len=GetWindowsDirectoryW(windows,32768);
    if(!len||len>=32768||within(exe,std::wstring(windows,len),true))return L"Windows system process";
    const auto name=exe.substr(exe.find_last_of(L"\\/")+1);
    if(same(name,L"explorer.exe")||same(name,L"msedgewebview2.exe"))return L"Explorer or preview runtime";
    if(same(exe,image(GetCurrentProcess()))||same(name,L"All View.exe")||same(name,L"all-view.exe"))return L"All View process";
    return {};
}
struct Process {
    HANDLE handle=nullptr;uint64_t created=0;std::wstring exe,reason;std::set<std::wstring> paths;
    ~Process(){if(handle)CloseHandle(handle);}
};
struct CloseContext {DWORD pid;unsigned sent=0;};
BOOL CALLBACK close_window(HWND w,LPARAM data){
    auto c=reinterpret_cast<CloseContext*>(data);DWORD pid=0;GetWindowThreadProcessId(w,&pid);
    if(pid==c->pid && GetWindow(w,GW_OWNER)==nullptr && PostMessageW(w,WM_CLOSE,0,0))++c->sent;
    return TRUE;
}
}

// Returns zero on success, 1 for a bounded partial scan, negative for API failure.
extern "C" int av_lock_scan(const wchar_t* path,void* context,Match callback,unsigned* inaccessible){
    auto ntdll=GetModuleHandleW(L"ntdll.dll");
    auto query=reinterpret_cast<QuerySystem>(GetProcAddress(ntdll,"NtQuerySystemInformation"));
    auto names=reinterpret_cast<QueryObject>(GetProcAddress(ntdll,"NtQueryObject"));
    if(!query||!names)return -1;
    DWORD attributes=GetFileAttributesW(path);
    if(attributes==INVALID_FILE_ATTRIBUTES)return -2;
    if(attributes&FILE_ATTRIBUTE_REPARSE_POINT)return -3;
    const bool directory=(attributes&FILE_ATTRIBUTE_DIRECTORY)!=0;
    Owned target(CreateFileW(path,0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    if(!target)return -2;
    std::wstring root=object_name(names,target.value);while(root.size()>1&&root.back()==L'\\')root.pop_back();if(root.empty())return -2;
    std::wstring dos(32768,L'\0');DWORD dos_length=GetFinalPathNameByHandleW(target.value,dos.data(),DWORD(dos.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
    if(!dos_length||dos_length>=dos.size())return -2;dos.resize(dos_length);
    if(dos.compare(0,8,L"\\\\?\\UNC\\")==0)dos=L"\\\\"+dos.substr(8);else if(dos.compare(0,4,L"\\\\?\\")==0)dos.erase(0,4);
    while(dos.size()>1&&dos.back()==L'\\')dos.pop_back();
    std::vector<BYTE> buffer(1<<20);NTSTATUS status=0;ULONG needed=0;
    for(;;){
        status=query(64,buffer.data(),ULONG(buffer.size()),&needed);
        if(status!=static_cast<NTSTATUS>(0xC0000004))break;
        size_t next=std::max(buffer.size()*2,size_t(needed)+65536);if(next>128*1024*1024)return -4;buffer.resize(next);
    }
    if(status<0)return -1;
    auto table=reinterpret_cast<HandleTable*>(buffer.data());
    if(table->count>(buffer.size()-offsetof(HandleTable,entries))/sizeof(HandleEntry))return -1;
    USHORT file_type=0;
    for(size_t i=0;i<table->count;i++)if(table->entries[i].pid==GetCurrentProcessId()&&table->entries[i].value==reinterpret_cast<ULONG_PTR>(target.value)){file_type=table->entries[i].type;break;}
    if(!file_type)return -1;
    std::map<DWORD,Process> processes;std::set<DWORD> denied;size_t matches=0,characters=0;bool partial=false;auto started=GetTickCount64();
    auto emit=[&](DWORD pid,Process& p,const std::wstring& display){
        if(p.paths.count(display))return;
        if(p.paths.size()>=8||matches>=512||characters+display.size()+p.exe.size()>300000){partial=true;return;}
        p.paths.insert(display);++matches;characters+=display.size()+p.exe.size();
        callback(context,pid,p.created,p.exe.c_str(),display.c_str(),p.reason.c_str());
    };
    std::unique_ptr<NameWorker> name_worker;unsigned stalls=0;
    for(size_t i=0;i<table->count;i++){
        if(GetTickCount64()-started>10000){partial=true;break;}
        const auto& entry=table->entries[i];if(entry.type!=file_type||entry.pid>MAXDWORD||entry.pid==GetCurrentProcessId())continue;
        DWORD pid=DWORD(entry.pid);auto& p=processes[pid];
        if(!p.handle){
            if(denied.count(pid))continue;
            p.handle=OpenProcess(PROCESS_DUP_HANDLE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
            if(!p.handle){denied.insert(pid);continue;}
            p.created=birth(p.handle);p.exe=image(p.handle);p.reason=protected_reason(p.handle,pid,p.exe);
        }
        if(!name_worker){try{name_worker=std::make_unique<NameWorker>(names);}catch(...){partial=true;break;}}
        HANDLE copy=nullptr;if(!DuplicateHandle(p.handle,reinterpret_cast<HANDLE>(entry.value),GetCurrentProcess(),&copy,0,FALSE,DUPLICATE_SAME_ACCESS)){partial=true;continue;}
        auto result=name_worker->query(copy);
        if(!result){partial=true;name_worker.reset();if(++stalls>=8)break;continue;}
        auto& name=*result;if(name.empty())continue;
        if(!within(name,root,directory))continue;
        // Display the selected path plus the kernel-relative suffix, not a device name.
        std::wstring display(path);display+=name.substr(root.size());
        emit(pid,p,display);
        if(matches>=512||characters>290000){partial=true;break;}
    }
    // Executables and DLLs can remain mapped after their ordinary file handles close.
    DWORD pids[16384],used=0;
    if(!EnumProcesses(pids,sizeof(pids),&used))partial=true;
    else {
        if(used==sizeof(pids))partial=true;
        for(size_t i=0;i<used/sizeof(DWORD);i++){
            if(GetTickCount64()-started>10000||matches>=512||characters>290000){partial=true;break;}
            DWORD pid=pids[i];if(!pid||pid==GetCurrentProcessId())continue;
            Owned process(OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_VM_READ,FALSE,pid));
            if(!process){denied.insert(pid);continue;}
            HMODULE modules[2048];DWORD bytes=0;
            if(!EnumProcessModulesEx(process.value,modules,sizeof(modules),&bytes,LIST_MODULES_ALL)){partial=true;continue;}
            if(bytes>sizeof(modules))partial=true;
            for(size_t j=0;j<std::min(size_t(bytes/sizeof(HMODULE)),size_t(2048));j++){
                wchar_t module[32768];DWORD n=GetModuleFileNameExW(process.value,modules[j],module,32768);
                if(!n||n>=32768){partial=true;continue;}
                std::wstring name(module,n);if(!within(name,dos,directory))continue;
                auto& p=processes[pid];if(!p.created){p.created=birth(process.value);p.exe=image(process.value);p.reason=protected_reason(process.value,pid,p.exe);}
                std::wstring display(path);display+=name.substr(dos.size());emit(pid,p,display);
            }
        }
    }
    *inaccessible=unsigned(denied.size());return partial?1:0;
}

// A retained process handle plus creation time protects against PID reuse.
// No debug privilege, service stop, remote handle closure or automatic elevation.
extern "C" int av_lock_release(DWORD pid,uint64_t created,bool force){
    Owned p(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE|(force?PROCESS_TERMINATE:0),FALSE,pid));
    if(!p)return -1;
    if(!created||birth(p.value)!=created||WaitForSingleObject(p.value,0)!=WAIT_TIMEOUT)return -2;
    if(!protected_reason(p.value,pid,image(p.value)).empty())return -3;
    if(force)return TerminateProcess(p.value,1)?2:-1;
    CloseContext context{pid};EnumWindows(close_window,reinterpret_cast<LPARAM>(&context));return context.sent?1:0;
}

#ifdef AV_INPUT_TESTS
extern "C" bool av_test_lock_paths(){
    return within(L"\\Device\\V\\Folder",L"\\device\\v\\folder",true)&&
        within(L"\\Device\\V\\Folder\\child",L"\\Device\\V\\Folder",true)&&
        !within(L"\\Device\\V\\Folder-other\\child",L"\\Device\\V\\Folder",true)&&
        !within(L"\\Device\\V\\Folder\\child",L"\\Device\\V\\Folder",false)&&
        !protected_reason(GetCurrentProcess(),GetCurrentProcessId(),image(GetCurrentProcess())).empty()&&
        av_lock_release(GetCurrentProcessId(),1,true)==-2&&
        av_lock_release(GetCurrentProcessId(),birth(GetCurrentProcess()),true)==-3;
}
#endif
