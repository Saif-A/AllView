#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <cstdint>
#include <cwchar>
#include <cstring>
#include <vector>
// Clipboard/file primitives only. Interactive capture lives in the ShareX helper.
static void pack_dib(BITMAPV5HEADER* header,const unsigned char* rgba,unsigned int w,unsigned int h){
 memset(header,0,sizeof(*header));header->bV5Size=sizeof(*header);header->bV5Width=w;header->bV5Height=-static_cast<LONG>(h);header->bV5Planes=1;header->bV5BitCount=32;header->bV5Compression=BI_BITFIELDS;header->bV5RedMask=0x00ff0000;header->bV5GreenMask=0x0000ff00;header->bV5BlueMask=0x000000ff;header->bV5AlphaMask=0xff000000;header->bV5CSType=LCS_sRGB;
 auto dest=reinterpret_cast<unsigned char*>(header+1);for(size_t i=0;i<static_cast<size_t>(w)*h*4;i+=4){dest[i]=rgba[i+2];dest[i+1]=rgba[i+1];dest[i+2]=rgba[i];dest[i+3]=rgba[i+3];}
}
extern "C" {
__declspec(dllexport) unsigned int av_double_click_time(){return GetDoubleClickTime();}
__declspec(dllexport) bool av_open_directory(const wchar_t* path){return path&&reinterpret_cast<intptr_t>(ShellExecuteW(nullptr,L"open",path,nullptr,nullptr,SW_SHOWNORMAL))>32;}
// The parent owns this unnamed job. Exiting/crashing kills only its own editor children.
__declspec(dllexport) bool av_assign_child_job(intptr_t process){
 static HANDLE job=[](){HANDLE value=CreateJobObjectW(nullptr,nullptr);if(!value)return static_cast<HANDLE>(nullptr);JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;if(!SetInformationJobObject(value,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){CloseHandle(value);return static_cast<HANDLE>(nullptr);}return value;}();
 return job&&AssignProcessToJobObject(job,reinterpret_cast<HANDLE>(process));
}
__declspec(dllexport) bool av_capture_home(wchar_t* buffer,int size){PWSTR path=nullptr;if(FAILED(SHGetKnownFolderPath(FOLDERID_Pictures,0,nullptr,&path))||!path)return false;bool ok=wcsncpy_s(buffer,size,path,_TRUNCATE)==0;CoTaskMemFree(path);return ok;}
__declspec(dllexport) void av_local_time(unsigned short* values){SYSTEMTIME t{};GetLocalTime(&t);values[0]=t.wYear;values[1]=t.wMonth;values[2]=t.wDay;values[3]=t.wHour;values[4]=t.wMinute;values[5]=t.wSecond;}
__declspec(dllexport) bool av_replace_image(const wchar_t* source,const wchar_t* replacement){return ReplaceFileW(source,replacement,nullptr,REPLACEFILE_IGNORE_MERGE_ERRORS,nullptr,nullptr)!=FALSE;}
__declspec(dllexport) bool av_image_identity(const wchar_t* path,uint64_t* values){HANDLE f=CreateFileW(path,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);if(f==INVALID_HANDLE_VALUE)return false;BY_HANDLE_FILE_INFORMATION info{};bool ok=GetFileInformationByHandle(f,&info)!=FALSE;CloseHandle(f);if(!ok||(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)))return false;values[0]=(static_cast<uint64_t>(info.nFileSizeHigh)<<32)|info.nFileSizeLow;values[1]=(static_cast<uint64_t>(info.ftLastWriteTime.dwHighDateTime)<<32)|info.ftLastWriteTime.dwLowDateTime;values[2]=(static_cast<uint64_t>(info.ftCreationTime.dwHighDateTime)<<32)|info.ftCreationTime.dwLowDateTime;values[3]=info.dwVolumeSerialNumber;values[4]=(static_cast<uint64_t>(info.nFileIndexHigh)<<32)|info.nFileIndexLow;values[5]=info.nNumberOfLinks;return true;}
__declspec(dllexport) bool av_copy_image(intptr_t owner,const unsigned char* rgba,unsigned int w,unsigned int h,const unsigned char* png,size_t length){
 if(!rgba||!png||!w||!h||static_cast<uint64_t>(w)*h>16000000||length>64*1024*1024)return false;size_t count=static_cast<size_t>(w)*h*4;HGLOBAL dib=GlobalAlloc(GMEM_MOVEABLE,sizeof(BITMAPV5HEADER)+count),encoded=GlobalAlloc(GMEM_MOVEABLE,length);if(!dib||!encoded){if(dib)GlobalFree(dib);if(encoded)GlobalFree(encoded);return false;}
 auto header=static_cast<BITMAPV5HEADER*>(GlobalLock(dib));void* pngData=GlobalLock(encoded);if(!header||!pngData){if(header)GlobalUnlock(dib);if(pngData)GlobalUnlock(encoded);GlobalFree(dib);GlobalFree(encoded);return false;}
 pack_dib(header,rgba,w,h);memcpy(pngData,png,length);GlobalUnlock(dib);GlobalUnlock(encoded);UINT pngFormat=RegisterClipboardFormatW(L"PNG");if(!pngFormat||!OpenClipboard(reinterpret_cast<HWND>(owner))){GlobalFree(dib);GlobalFree(encoded);return false;}
 bool ok=EmptyClipboard()!=FALSE;if(ok){if(SetClipboardData(CF_DIBV5,dib))dib=nullptr;else ok=false;if(SetClipboardData(pngFormat,encoded))encoded=nullptr;else ok=false;}CloseClipboard();if(dib)GlobalFree(dib);if(encoded)GlobalFree(encoded);return ok;
}
#ifdef AV_INPUT_TESTS
__declspec(dllexport) bool av_test_clipboard_layout(){std::vector<unsigned char> packed(sizeof(BITMAPV5HEADER)+8);const unsigned char rgba[]={30,20,10,255,60,50,40,128};auto header=reinterpret_cast<BITMAPV5HEADER*>(packed.data());pack_dib(header,rgba,2,1);return header->bV5Height==-1&&header->bV5RedMask==0x00ff0000&&packed[sizeof(BITMAPV5HEADER)]==10&&packed[sizeof(BITMAPV5HEADER)+7]==128;}
#endif
}
