#pragma once
#include <windows.h>
#include <string>
// Called only on the resolver STA, after the native foreground/edit guard.
std::wstring breadcrumb_selection(HWND window,HWND focused_list);
// Native-selected paths only. Returns the original shortcut on an invalid/virtual/cyclic target.
std::wstring preview_link_target(const std::wstring& path);
#ifdef AV_INPUT_TESTS
extern "C" int av_test_shell_links(const wchar_t* root);
extern "C" int av_test_shell_ambiguity(const wchar_t* root);
#endif
