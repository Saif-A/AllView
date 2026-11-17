// Native .NET hosting ABI; no managed editor executable or child process.
#include <windows.h>
#include "runtime_setup.h"
#include "package_integration.h"
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <string>
#include <mutex>
#include <algorithm>
namespace {
using entry_fn = int(__stdcall*)(void*, int32_t);
using locate_fn = int(__stdcall*)(wchar_t*, size_t*, const void*);
struct locate_parameters {size_t size;const wchar_t* assembly_path;const wchar_t* dotnet_root;};
using init_fn = int(__cdecl*)(const wchar_t*, const void*, void**);
using delegate_fn = int(__cdecl*)(void*, int, void**);
using close_fn = int(__cdecl*)(void*);
using load_fn = int(__stdcall*)(const wchar_t*, const wchar_t*, const wchar_t*, const wchar_t*, void*, void**);
std::mutex gate;
entry_fn entry = nullptr;
HMODULE resolver = nullptr, runtime = nullptr;
bool missing_framework(int result) { return static_cast<uint32_t>(result)==0x80008096u; }
void error(char* output, int size, const char* message) {
    if (output && size > 0) { auto n = std::min<size_t>(size - 1, strlen(message)); memcpy(output, message, n); output[n] = 0; }
}
}
extern "C" int av_editor_run(const wchar_t* directory, void* request, int size, char* message, int capacity) {
    std::lock_guard<std::mutex> lock(gate);
    try {
        for (int attempt=0; !entry && attempt<2; ++attempt) {
            std::wstring root(directory), assembly = root + L"\\allview-editor.dll", config = root + L"\\allview-editor.runtimeconfig.json";
            if (GetFileAttributesW(assembly.c_str()) == INVALID_FILE_ATTRIBUTES || GetFileAttributesW(config.c_str()) == INVALID_FILE_ATTRIBUTES) { error(message, capacity, "All View editor library is missing. Use the complete release folder."); return -1; }
            if (!resolver) resolver = LoadLibraryExW((root + L"\\nethost.dll").c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
            auto locate = resolver ? reinterpret_cast<locate_fn>(GetProcAddress(resolver, "get_hostfxr_path")) : nullptr;
            wchar_t path[32768]; size_t length = 32768;
            if (!locate) { error(message, capacity, "The editor runtime host library is missing or damaged. Use the complete All View release folder."); return -1; }
            const auto local_runtime=root+L"\\dotnet";
            const bool packaged=av_has_package_identity();
            locate_parameters parameters{sizeof(locate_parameters),assembly.c_str(),local_runtime.c_str()};
            if (locate(path, &length, packaged?&parameters:nullptr) != 0) {if(!packaged&&attempt==0&&av_install_desktop_runtime())continue;error(message, capacity, packaged?"The bundled editor runtime is missing or damaged. Repair All View from Windows Settings.":"The .NET Desktop Runtime setup did not complete or is not available yet. Retry capture/editing; check your connection or Windows installer message.");return -2;}
            if (!runtime) runtime = LoadLibraryExW(path, nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
            auto init = runtime ? reinterpret_cast<init_fn>(GetProcAddress(runtime, "hostfxr_initialize_for_runtime_config")) : nullptr;
            auto get = runtime ? reinterpret_cast<delegate_fn>(GetProcAddress(runtime, "hostfxr_get_runtime_delegate")) : nullptr;
            auto close = runtime ? reinterpret_cast<close_fn>(GetProcAddress(runtime, "hostfxr_close")) : nullptr;
            void* context = nullptr;
            if (!init || !get || !close) { error(message, capacity, "The installed .NET hosting runtime is unavailable."); return -3; }
            auto result = init(config.c_str(), nullptr, &context);
            if (result < 0 || !context) {if(context)close(context);FreeLibrary(runtime);runtime=nullptr;if(missing_framework(result)){if(!packaged&&attempt==0&&av_install_desktop_runtime())continue;error(message, capacity, packaged?"The bundled editor runtime is unavailable. Repair All View from Windows Settings.":"The .NET Desktop Runtime setup did not complete. Retry capture/editing after resolving the Windows installer message.");return -4;}error(message, capacity, "The All View editor runtime configuration could not be loaded.");return -4; }
            void* loader = nullptr; result = get(context, 5, &loader); close(context);
            if (result < 0 || !loader) { error(message, capacity, "Could not initialize the All View editor runtime."); return -5; }
            void* target = nullptr;
            result = reinterpret_cast<load_fn>(loader)(assembly.c_str(), L"AllView.Editor.Entry, allview-editor", L"Run", reinterpret_cast<const wchar_t*>(-1), nullptr, &target);
            if (result < 0 || !target) { error(message, capacity, "Could not load the All View editor library."); return -6; }
            entry = reinterpret_cast<entry_fn>(target);
        }
        return entry(request, size);
    } catch (...) { error(message, capacity, "The All View editor could not be initialized."); return -7; }
}
extern "C" int av_editor_runtime_path(wchar_t* output,int capacity){
    auto module=GetModuleHandleW(L"coreclr.dll");
    return module&&output&&capacity>0?static_cast<int>(GetModuleFileNameW(module,output,capacity)):0;
}
#ifdef AV_INPUT_TESTS
extern "C" int av_test_runtime_install_policy(){
 if(!missing_framework(static_cast<int>(0x80008096u))||missing_framework(0)||missing_framework(static_cast<int>(0x80008093u)))return 1;
 if(!av_runtime_install_success(0)||!av_runtime_install_success(3010))return 2;
 if(av_runtime_install_success(1602)||av_runtime_install_success(1603)||av_runtime_install_success(1641))return 3;
 return 0;
}
#endif
