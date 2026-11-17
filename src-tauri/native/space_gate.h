#pragma once

// No Windows calls or cached selection: qualify the first press and balance
// its key-up, while a held key produces at most one resolve request.
struct SpaceDecision { bool consume; bool resolve; };
struct SpaceGate {
    bool held = false;
    static bool eligible(bool enabled, bool modified, bool file_list) {
        return enabled && !modified && file_list;
    }
    SpaceDecision down(bool allowed) {
        if (held) return {true, false};
        if (!allowed) return {false, false};
        held = true;
        return {true, true};
    }
    bool up() { bool consumed = held; held = false; return consumed; }
    // A release can be missed while foreground/input queues change. Sample the
    // physical state on the foreground event, never inside the keyboard hook.
    void foreground(bool space_down) { if (!space_down) held = false; }
    void cancel() { held = false; }
};
