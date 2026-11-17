#pragma once
#include <windows.h>
// Runs only after the managed host reports a missing framework. No SDK.
bool av_install_desktop_runtime();
inline bool av_runtime_install_success(DWORD code) { return code == 0 || code == 3010; }
