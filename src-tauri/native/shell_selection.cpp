#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <UIAutomation.h>
#include <vector>
#include <chrono>
#include <algorithm>
#include <cstring>
#include "com_ptr.h"
#include "shell_selection.h"

namespace {
constexpr size_t element_limit=384,entry_limit=20000,depth_limit=24;
struct Budget {
    size_t entries=0;
    std::chrono::steady_clock::time_point deadline=std::chrono::steady_clock::now()+std::chrono::seconds(3);
    bool live()const{return std::chrono::steady_clock::now()<deadline;}
};
struct Pidl {PIDLIST_ABSOLUTE p=nullptr;~Pidl(){CoTaskMemFree(p);}};
std::wstring display(IShellItem* item){PWSTR text=nullptr;if(FAILED(item->GetDisplayName(SIGDN_NORMALDISPLAY,&text)))return {};std::wstring value=text?text:L"";CoTaskMemFree(text);return value;}
std::wstring file_path(IShellItem* item){PWSTR text=nullptr;if(FAILED(item->GetDisplayName(SIGDN_FILESYSPATH,&text)))return {};std::wstring value=text?text:L"";CoTaskMemFree(text);return value;}
std::wstring element_name(IUIAutomationElement* element){BSTR text=nullptr;if(FAILED(element->get_CurrentName(&text)))return {};std::wstring value=text?text:L"";SysFreeString(text);return value.size()<=1024?value:L"";}
bool automation_id(IUIAutomationElement* element,const wchar_t* expected){BSTR text=nullptr;element->get_CurrentAutomationId(&text);bool match=text&&wcscmp(text,expected)==0;SysFreeString(text);return match;}

// Bounded breadth-first traversal avoids an unbounded descendant query in a huge file list.
Com<IUIAutomationElement> find_crumb_bar(IUIAutomation* automation,IUIAutomationElement* root,Budget& budget){
    Com<IUIAutomationTreeWalker> walker;if(FAILED(automation->get_ControlViewWalker(walker.out())))return {};
    std::vector<Com<IUIAutomationElement>> queue;queue.reserve(element_limit);Com<IUIAutomationElement> start;root->AddRef();start.p=root;queue.push_back(std::move(start));
    for(size_t index=0;index<queue.size()&&budget.live();++index){
        if(automation_id(queue[index].p,L"PART_BreadcrumbBar"))return std::move(queue[index]);
        Com<IUIAutomationElement> child;walker->GetFirstChildElement(queue[index].p,child.out());
        while(child&&queue.size()<element_limit&&budget.live()){
            Com<IUIAutomationElement> next;walker->GetNextSiblingElement(child.p,next.out());queue.push_back(std::move(child));child=std::move(next);
        }
    }
    return {};
}
std::vector<std::wstring> breadcrumbs(IUIAutomation* automation,IUIAutomationElement* root,Budget& budget){
    auto bar=find_crumb_bar(automation,root,budget);if(!bar)return {};
    Com<IUIAutomationTreeWalker> walker;if(FAILED(automation->get_ControlViewWalker(walker.out())))return {};
    std::vector<std::wstring> names;Com<IUIAutomationElement> child;walker->GetFirstChildElement(bar.p,child.out());
    for(size_t count=0;child&&count<depth_limit+3&&budget.live();++count){
        CONTROLTYPEID type=0;child->get_CurrentControlType(&type);
        if(type==UIA_SplitButtonControlTypeId){auto name=element_name(child.p);if(name.empty())return {};names.push_back(std::move(name));}
        Com<IUIAutomationElement> next;walker->GetNextSiblingElement(child.p,next.out());child=std::move(next);
    }
    if(child)return {};return names;
}
struct Selection {Com<IUIAutomationElement> element;std::wstring name;};
Selection selected(IUIAutomation* automation,HWND list){
    Com<IUIAutomationElement> root;if(FAILED(automation->ElementFromHandle(list,root.out())))return {};
    Com<IUIAutomationSelectionPattern> pattern;
    if(FAILED(root->GetCurrentPatternAs(UIA_SelectionPatternId,IID_PPV_ARGS(pattern.out())))){
        Com<IUIAutomationCondition> condition;VARIANT type{};type.vt=VT_I4;type.lVal=UIA_ListControlTypeId;
        automation->CreatePropertyCondition(UIA_ControlTypePropertyId,type,condition.out());Com<IUIAutomationElement> view;
        if(!condition||FAILED(root->FindFirst(TreeScope_Children,condition.p,view.out()))||!view||FAILED(view->GetCurrentPatternAs(UIA_SelectionPatternId,IID_PPV_ARGS(pattern.out()))))return {};
    }
    Com<IUIAutomationElementArray> values;int count=0;
    if(FAILED(pattern->GetCurrentSelection(values.out()))||!values||FAILED(values->get_Length(&count))||count!=1)return {};
    Selection result;if(FAILED(values->GetElement(0,result.element.out())))return {};result.name=element_name(result.element.p);return result;
}
Com<IShellItem> unique_child(IShellItem* parent,const std::wstring& name,bool folders,Budget& budget){
    if(!budget.live()||budget.entries>=entry_limit)return {};
    Com<IShellFolder> folder;if(FAILED(parent->BindToHandler(nullptr,BHID_SFObject,IID_PPV_ARGS(folder.out()))))return {};
    Com<IEnumIDList> children;SHCONTF flags=SHCONTF_FOLDERS|SHCONTF_INCLUDEHIDDEN;if(!folders)flags|=SHCONTF_NONFOLDERS;
    if(FAILED(folder->EnumObjects(nullptr,flags,children.out()))||!children)return {};
    Pidl parent_id;if(FAILED(SHGetIDListFromObject(parent,&parent_id.p)))return {};
    Com<IShellItem> match;
    while(budget.live()){
        PITEMID_CHILD child=nullptr;ULONG fetched=0;auto hr=children->Next(1,&child,&fetched);
        if(hr==S_FALSE&&fetched==0)return match;
        if(FAILED(hr)||fetched!=1||!child)return {};
        if(++budget.entries>entry_limit){CoTaskMemFree(child);return {};}
        Com<IShellItem> item;hr=SHCreateItemWithParent(parent_id.p,folder.p,child,IID_PPV_ARGS(item.out()));CoTaskMemFree(child);
        if(FAILED(hr))return {};
        if(display(item.p)==name){if(match)return {};match=std::move(item);}
    }
    return {};
}
}

std::wstring breadcrumb_selection(HWND window,HWND focused_list){
    Budget budget;Com<IUIAutomation> automation;
    if(FAILED(CoCreateInstance(CLSID_CUIAutomation8,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(automation.out()))))return {};
    Com<IUIAutomation2> limits;if(SUCCEEDED(automation->QueryInterface(IID_PPV_ARGS(limits.out())))){limits->put_ConnectionTimeout(200);limits->put_TransactionTimeout(200);}
    Com<IUIAutomationElement> root;if(FAILED(automation->ElementFromHandle(window,root.out())))return {};
    auto first=selected(automation.p,focused_list);if(first.name.empty())return {};
    auto names=breadcrumbs(automation.p,root.p,budget);if(names.empty())return {};
    Com<IShellItem> current;if(FAILED(SHGetKnownFolderItem(FOLDERID_ComputerFolder,KF_FLAG_DEFAULT,nullptr,IID_PPV_ARGS(current.out()))))return {};
    auto computer=display(current.p);auto begin=std::find(names.begin(),names.end(),computer);
    if(computer.empty()||begin==names.end()||begin-names.begin()>1||std::find(begin+1,names.end(),computer)!=names.end())return {};
    if(names.end()-begin>depth_limit)return {};
    for(auto name=begin+1;name!=names.end();++name){current=unique_child(current.p,*name,true,budget);if(!current)return {};}
    auto item=unique_child(current.p,first.name,false,budget);if(!item)return {};
    auto path=file_path(item.p);if(path.empty()||path.size()>=32768)return {};
    auto last=selected(automation.p,focused_list);BOOL same=FALSE;
    if(last.name!=first.name||!last.element||FAILED(automation->CompareElements(first.element.p,last.element.p,&same))||!same||breadcrumbs(automation.p,root.p,budget)!=names||!budget.live())return {};
    return path;
}

namespace {
template<class Reader> std::wstring follow_preview_links(const std::wstring& source,Reader&& read){
    std::wstring path=source;std::vector<std::wstring> visited;
    for(size_t depth=0;depth<=8;++depth){
        auto dot=path.rfind(L'.');if(dot==std::wstring::npos||_wcsicmp(path.c_str()+dot,L".lnk")!=0)return path;
        if(depth==8)return source;
        for(const auto& old:visited)if(_wcsicmp(old.c_str(),path.c_str())==0)return source;
        visited.push_back(path);auto next=read(path);
        // URI/command strings and relative links never become preview paths.
        if(next.size()<3||!((next[1]==L':'&&(next[2]==L'\\'||next[2]==L'/'))||(next[0]==L'\\'&&next[1]==L'\\')))return source;
        path=std::move(next);
    }
    return source;
}
std::wstring read_link_path(const std::wstring& path){
    Com<IShellLinkW> link;Com<IPersistFile> file;
    if(FAILED(CoCreateInstance(CLSID_ShellLink,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(link.out())))||FAILED(link->QueryInterface(IID_PPV_ARGS(file.out())))||FAILED(file->Load(path.c_str(),STGM_READ)))return {};
    std::wstring next;wchar_t raw[32768]{};
    // Stored paths keep link traversal under our own hop/cycle policy.
    if(SUCCEEDED(link->GetPath(raw,32768,nullptr,SLGP_RAWPATH))&&*raw){wchar_t expanded[32768]{};DWORD size=ExpandEnvironmentStringsW(raw,expanded,32768);if(!size||size>=32768)return {};next=expanded;}
    if(next.empty()){Pidl target;if(SUCCEEDED(link->GetIDList(&target.p))&&target.p){Com<IShellItem> item;if(SUCCEEDED(SHCreateItemFromIDList(target.p,IID_PPV_ARGS(item.out()))))next=file_path(item.p);}}
    return next;
}
}
std::wstring preview_link_target(const std::wstring& source){return follow_preview_links(source,read_link_path);}

#ifdef AV_INPUT_TESTS
namespace {
bool test_file(const std::wstring& path,const char* text){HANDLE file=CreateFileW(path.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);if(file==INVALID_HANDLE_VALUE)return false;DWORD done=0;bool ok=WriteFile(file,text,(DWORD)strlen(text),&done,nullptr)&&done==strlen(text);CloseHandle(file);return ok;}
bool test_link(const std::wstring& source,const std::wstring& target){
    Com<IShellLinkW> link;Com<IPersistFile> file;if(FAILED(CoCreateInstance(CLSID_ShellLink,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(link.out()))))return false;
    if(FAILED(link->SetPath(target.c_str())))return false;
    // Stored shortcut arguments must never be invoked by preview resolution.
    link->SetArguments(L"--never-execute-preview-tests");
    return SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(file.out())))&&SUCCEEDED(file->Save(source.c_str(),TRUE));
}
std::vector<char> test_bytes(const std::wstring& path){HANDLE file=CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);if(file==INVALID_HANDLE_VALUE)return {};DWORD size=GetFileSize(file,nullptr),read=0;if(size>65536){CloseHandle(file);return {};}std::vector<char> bytes(size);bool ok=ReadFile(file,bytes.data(),size,&read,nullptr)&&read==size;CloseHandle(file);return ok?bytes:std::vector<char>{};}
struct Apartment{HRESULT hr=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);~Apartment(){if(SUCCEEDED(hr))CoUninitialize();}};
}
extern "C" int av_test_shell_links(const wchar_t* root){
    Apartment apartment;if(FAILED(apartment.hr))return 1;
    const std::wstring base=root,target=base+L"\\Unicode-\x0627\x0644\x0639\x0631\x0628\x064a\x0629.txt",link=base+L"\\target.lnk";
    if(!test_file(target,"Preview source remains unchanged")||!test_link(link,target))return 2;
    auto before=test_bytes(link),source=test_bytes(target);if(preview_link_target(link)!=target||test_bytes(link)!=before||test_bytes(target)!=source)return 3;
    auto missing=base+L"\\missing.txt",broken=base+L"\\broken.lnk";if(!test_link(broken,missing)||preview_link_target(broken)!=missing)return 4;
    auto folder=base+L"\\folder",folder_link=base+L"\\folder.lnk";if(!CreateDirectoryW(folder.c_str(),nullptr)||!test_link(folder_link,folder)||preview_link_target(folder_link)!=folder)return 5;
    auto corrupt=base+L"\\corrupt.lnk";if(!test_file(corrupt,"not a shortcut")||preview_link_target(corrupt)!=corrupt)return 6;
    // Windows normalizes or rejects link-to-link fixtures during creation.
    // Exercise that traversal policy with controlled readers independently of
    // the genuine Shell-link parser/source-preservation cases above and below.
    auto first=base+L"\\cycle-a.lnk",second=base+L"\\cycle-b.lnk";int reads=0;
    auto cycle=[&](const std::wstring& path){++reads;return path==first?second:first;};
    if(follow_preview_links(first,cycle)!=first||reads!=2)return 7;
    std::vector<std::wstring> chain;for(int i=0;i<9;i++)chain.push_back(base+L"\\chain-"+std::to_wstring(i)+L".lnk");
    auto reader=[&](const std::wstring& path){++reads;auto index=std::find(chain.begin(),chain.end(),path)-chain.begin();return index==8?target:chain[index+1];};
    reads=0;if(follow_preview_links(chain[1],reader)!=target||reads!=8)return 10;
    reads=0;if(follow_preview_links(chain[0],reader)!=chain[0]||reads!=8)return 12;
    if(follow_preview_links(first,[](const std::wstring&){return std::wstring(L"https://example.invalid/");})!=first)return 13;
    auto virtual_link=base+L"\\virtual.lnk";Com<IShellLinkW> shell_link;Com<IPersistFile> persist;Pidl id;
    if(FAILED(CoCreateInstance(CLSID_ShellLink,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(shell_link.out())))||FAILED(SHGetKnownFolderIDList(FOLDERID_RecycleBinFolder,0,nullptr,&id.p))||FAILED(shell_link->SetIDList(id.p))||FAILED(shell_link->QueryInterface(IID_PPV_ARGS(persist.out())))||FAILED(persist->Save(virtual_link.c_str(),TRUE))||preview_link_target(virtual_link)!=virtual_link)return 11;
    return 0;
}
extern "C" int av_test_shell_ambiguity(const wchar_t* root){
    Apartment apartment;if(FAILED(apartment.hr))return 1;const std::wstring base=root,plain=base+L"\\ambiguous",shortcut=plain+L".lnk";
    if(!test_file(plain,"same display label")||!test_link(shortcut,plain))return 2;
    Com<IShellItem> folder;if(FAILED(SHCreateItemFromParsingName(base.c_str(),nullptr,IID_PPV_ARGS(folder.out()))))return 3;
    Budget budget;if(unique_child(folder.p,L"ambiguous",false,budget))return 4;
    Budget exhausted;exhausted.entries=entry_limit;if(unique_child(folder.p,L"ambiguous",false,exhausted))return 5;
    Budget expired;expired.deadline=std::chrono::steady_clock::now()-std::chrono::seconds(1);if(unique_child(folder.p,L"ambiguous",false,expired))return 6;
    Budget unique;auto child=unique_child(folder.p,L"ambiguous.lnk",false,unique);
    // The shortcut extension is hidden by the Shell; an exact display label cannot be invented.
    if(child)return 7;
    return 0;
}
#endif
