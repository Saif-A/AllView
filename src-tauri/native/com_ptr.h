#pragma once
#include <utility>
template<class T> struct Com {
    T* p = nullptr;
    Com() = default;
    Com(const Com&) = delete;
    Com& operator=(const Com&) = delete;
    Com(Com&& other) noexcept : p(std::exchange(other.p,nullptr)) {}
    Com& operator=(Com&& other) noexcept {if(this!=&other){if(p)p->Release();p=std::exchange(other.p,nullptr);}return *this;}
    ~Com() { if (p) p->Release(); }
    T** out() { if (p) p->Release(); p = nullptr; return &p; }
    T* operator->() const { return p; }
    explicit operator bool() const { return p != nullptr; }
};
