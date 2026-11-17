// Package-owned startup registration replaces HKCU Run only for MSIX installs.
#include <windows.h>
#include <appmodel.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.ApplicationModel.Activation.h>
#include <thread>
#include <chrono>
#include "package_integration.h"
struct apartment_scope {
    apartment_scope(){winrt::init_apartment(winrt::apartment_type::multi_threaded);}
    ~apartment_scope(){winrt::uninit_apartment();}
};
bool av_has_package_identity() {
    UINT32 length=0;
    return GetCurrentPackageFullName(&length,nullptr)==ERROR_INSUFFICIENT_BUFFER;
}
extern "C" bool av_store_is_packaged(){return av_has_package_identity();}
extern "C" bool av_package_startup_launch() {
    if(!av_has_package_identity())return false;
    bool result=false;
    std::thread worker([&]{try {
        apartment_scope apartment;
        auto args=winrt::Windows::ApplicationModel::AppInstance::GetActivatedEventArgs();
        result=args&&args.Kind()==winrt::Windows::ApplicationModel::Activation::ActivationKind::StartupTask;
    }catch(...){result=false;}});
    worker.join();return result;
}
static bool startup_operation(bool change,bool enabled) {
    bool result=false;
    // Settings calls can arrive on the STA. Wait for WinRT on a separate MTA,
    // bounded to five seconds per operation, without pumping the UI thread.
    std::thread worker([&] {
        try {
            apartment_scope apartment;
            using namespace winrt::Windows::ApplicationModel;
            using namespace winrt::Windows::Foundation;
            auto pending=StartupTask::GetAsync(L"AllViewStartupTask");
            if(pending.wait_for(std::chrono::seconds(5))!=AsyncStatus::Completed)return;
            auto task=pending.GetResults();
            if(change) {
                if(enabled) {
                    // Windows keeps DisabledByUser/Policy authoritative.
                    auto request=task.RequestEnableAsync();
                    if(request.wait_for(std::chrono::seconds(5))!=AsyncStatus::Completed)return;
                    auto state=request.GetResults();
                    result=state==StartupTaskState::Enabled||state==StartupTaskState::EnabledByPolicy;
                } else {
                    task.Disable();
                    result=task.State()!=StartupTaskState::Enabled&&task.State()!=StartupTaskState::EnabledByPolicy;
                }
            } else result=task.State()==StartupTaskState::Enabled||task.State()==StartupTaskState::EnabledByPolicy;
        } catch(...) {result=false;}
    });
    worker.join();return result;
}
bool av_package_startup_enabled(){return startup_operation(false,false);}
bool av_package_set_startup(bool enabled){return startup_operation(true,enabled);}
