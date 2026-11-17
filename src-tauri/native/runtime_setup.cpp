#include "runtime_setup.h"
#include <winhttp.h>
#include <wintrust.h>
#include <softpub.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <string>
#include <vector>

namespace {
struct Internet { HINTERNET h=nullptr; ~Internet(){if(h)WinHttpCloseHandle(h);} };
struct File { HANDLE h=INVALID_HANDLE_VALUE; ~File(){if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);} };
struct Download { std::wstring path; ~Download(){if(!path.empty())DeleteFileW(path.c_str());} };
struct Status {
 HWND window=CreateWindowExW(WS_EX_TOPMOST,L"STATIC",L"All View: downloading .NET Desktop Runtime…",WS_CAPTION|WS_BORDER|WS_VISIBLE, CW_USEDEFAULT,CW_USEDEFAULT,480,80,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);
 ~Status(){if(window)DestroyWindow(window);}
 void paint(){MSG msg;while(PeekMessageW(&msg,window,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}}
};
bool trusted(HANDLE file,const wchar_t* path){
 // Hash is pinned to Microsoft's 10.0 release metadata, in addition to Authenticode.
 constexpr char expected[]="337dacab1636219147b3fe75e451bf5b1c17bca2c86328266d40c4ad1ff0a1e8391c4746ca7a5b702b65b61e8bfe834566cfc1b548cc10aef90b441357b10b69";
 BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;
 if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA512_ALGORITHM,nullptr,0)<0)return false;
 bool ok=BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0)>=0;unsigned char buffer[65536],digest[64];DWORD count=0;
 while(ok){if(!ReadFile(file,buffer,sizeof buffer,&count,nullptr)){ok=false;break;}if(!count)break;ok=BCryptHashData(hash,buffer,count,0)>=0;}
 if(ok)ok=BCryptFinishHash(hash,digest,sizeof digest,0)>=0;
 if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);
 if(!ok)return false;const char hex[]="0123456789abcdef";for(size_t i=0;i<64;i++)if(expected[i*2]!=hex[digest[i]>>4]||expected[i*2+1]!=hex[digest[i]&15])return false;
 WINTRUST_FILE_INFO info{};info.cbStruct=sizeof info;info.pcwszFilePath=path;info.hFile=file;
 WINTRUST_DATA data{};data.cbStruct=sizeof data;data.dwUIChoice=WTD_UI_NONE;data.fdwRevocationChecks=WTD_REVOKE_WHOLECHAIN;data.dwUnionChoice=WTD_CHOICE_FILE;data.pFile=&info;data.dwStateAction=WTD_STATEACTION_VERIFY;
 GUID action=WINTRUST_ACTION_GENERIC_VERIFY_V2;auto result=WinVerifyTrust(nullptr,&action,&data);data.dwStateAction=WTD_STATEACTION_CLOSE;WinVerifyTrust(nullptr,&action,&data);return result==ERROR_SUCCESS;
}
}
bool av_install_desktop_runtime(){
 try{
  Status status;status.paint();wchar_t temp[MAX_PATH],name[MAX_PATH];
  auto length=GetTempPathW(MAX_PATH,temp);if(!length||length>=MAX_PATH||!GetTempFileNameW(temp,L"avr",0,name))return false;
  Download download;download.path=std::wstring(name)+L".exe";DeleteFileW(name);
  {
   File output;output.h=CreateFileW(download.path.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_TEMPORARY,nullptr);if(output.h==INVALID_HANDLE_VALUE){download.path.clear();return false;}
   Internet session;session.h=WinHttpOpen(L"All View runtime setup",WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,WINHTTP_NO_PROXY_NAME,WINHTTP_NO_PROXY_BYPASS,0);if(!session.h)return false;
   WinHttpSetTimeouts(session.h,15000,15000,30000,30000);
   Internet connection;connection.h=WinHttpConnect(session.h,L"builds.dotnet.microsoft.com",INTERNET_DEFAULT_HTTPS_PORT,0);if(!connection.h)return false;
   Internet request;request.h=WinHttpOpenRequest(connection.h,L"GET",L"/dotnet/WindowsDesktop/10.0.14/windowsdesktop-runtime-10.0.14-win-x64.exe",nullptr,WINHTTP_NO_REFERER,WINHTTP_DEFAULT_ACCEPT_TYPES,WINHTTP_FLAG_SECURE);if(!request.h)return false;
   DWORD redirects=WINHTTP_OPTION_REDIRECT_POLICY_NEVER;WinHttpSetOption(request.h,WINHTTP_OPTION_REDIRECT_POLICY,&redirects,sizeof redirects);
   if(!WinHttpSendRequest(request.h,WINHTTP_NO_ADDITIONAL_HEADERS,0,WINHTTP_NO_REQUEST_DATA,0,0,0)||!WinHttpReceiveResponse(request.h,nullptr))return false;
   DWORD code=0,size=sizeof code;if(!WinHttpQueryHeaders(request.h,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,WINHTTP_HEADER_NAME_BY_INDEX,&code,&size,WINHTTP_NO_HEADER_INDEX)||code!=200)return false;
   unsigned char bytes[65536];DWORD count=0,written=0;unsigned long long total=0,start=GetTickCount64();
   for(;;){status.paint();if(GetTickCount64()-start>300000||!WinHttpReadData(request.h,bytes,sizeof bytes,&count))return false;if(!count)break;total+=count;if(total>128*1024*1024||!WriteFile(output.h,bytes,count,&written,nullptr)||written!=count)return false;}
   if(!total||!FlushFileBuffers(output.h))return false;
  }
  // Keep the validated executable read-locked through launch and installation.
  File verified;verified.h=CreateFileW(download.path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
  if(verified.h==INVALID_HANDLE_VALUE||!trusted(verified.h,download.path.c_str()))return false;
  if(status.window){DestroyWindow(status.window);status.window=nullptr;}
  SHELLEXECUTEINFOW launch{};launch.cbSize=sizeof launch;launch.fMask=SEE_MASK_NOCLOSEPROCESS|SEE_MASK_NOASYNC;launch.lpVerb=L"open";launch.lpFile=download.path.c_str();launch.lpParameters=L"/install /passive /norestart";launch.nShow=SW_SHOWNORMAL;
  if(!ShellExecuteExW(&launch)||!launch.hProcess)return false;
  File process;process.h=launch.hProcess;WaitForSingleObject(process.h,INFINITE);DWORD result=1;return GetExitCodeProcess(process.h,&result)&&av_runtime_install_success(result);
 }catch(...){return false;}
}
#ifdef AV_INPUT_TESTS
extern "C" int av_test_runtime_payload(const wchar_t* path){
 File file;file.h=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
 return file.h!=INVALID_HANDLE_VALUE&&trusted(file.h,path)?1:0;
}
#endif
