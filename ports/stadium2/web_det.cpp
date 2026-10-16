// Deterministic stepping for 2 player lockstep (N64WEB_DET builds, the runtime's N64_COSIM mode).
// - A pacer thread hands the runtime one video frame token every 1/60 s once the game has started; the runtime
//   advances a frame only on a token and only when every game thread is waiting (quiescent).
// - At each frame advance the controllers are latched for the frame (a test script, the live devices, or both players
//   online), and now and then a hash of the N64's RDRAM is logged, so two runs with the same inputs can be compared
//   ("[det] vi=<n> hash=<h>"); online, the two pages compare it every second.
#ifdef N64WEB_DET
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <emscripten.h>
#include <malloc.h>
#include <unistd.h>
#include <string>
#include <thread>
#include <vector>

#include "ultramodern/ultramodern.hpp"
#define XXH_INLINE_ALL
#include "xxhash.h"

extern uint64_t total_vis;
extern "C" uint32_t ultramodern_cosim_request_vi(uint32_t count);
extern "C" void ultramodern_cosim_reset_vi_counter(void);
extern "C" void ultramodern_voluntary_preemption_set_enabled(int enable);

namespace {
std::atomic<bool> pacer_started{false};

void pacer() {
    while (!ultramodern::is_game_started()) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    fprintf(stderr, "[det] deterministic stepping on: one frame token every 1/60 s\n");
    using clock = std::chrono::steady_clock;
    const auto frame = std::chrono::nanoseconds(1000000000LL * 1001 / 60000); // NTSC 59.94 Hz
    auto next = clock::now();
    uint64_t granted = 0;
    for (;;) {
        next += frame;
        std::this_thread::sleep_until(next);
        // At most a few tokens waiting: after a stall (the other player's input late, a slow frame) the game catches up
        // a few frames, instead of racing through every frame the stall lasted.
        if (granted >= total_vis + 4) {
            if (clock::now() - next > frame * 4) next = clock::now();
            continue;
        }
        granted += ultramodern_cosim_request_vi(1);
    }
}
}

extern "C" void n64web_det_start() {
    bool expected = false;
    if (pacer_started.compare_exchange_strong(expected, true)) {
        // Token control on before any game thread runs, so frame 0 is the same point of the boot on every machine.
        fprintf(stderr, "[det] token control on (game started: %d)\n", ultramodern::is_game_started() ? 1 : 0);
        ultramodern_cosim_reset_vi_counter();
        // The runtime's voluntary preemption yields a game thread it thinks is stuck, judged by the host clock: a thread
        // switch at a moment that differs between machines. Deterministic stepping delivers events at fixed points instead.
        ultramodern_voluntary_preemption_set_enabled(0);
        std::thread(pacer).detach();
    }
}

extern "C" int psr_cosim_on_quiescent_vi(uint8_t*, const ultramodern_cosim_quiescence_state*) { return 0; }


// ---- Inputs latched per video frame ----------------------------------------------------------------------------
// Every controller read the game makes during frame <vi> returns the same value on every machine: the input latched when
// that frame advanced. Sources, in order: online play (both players' inputs, below), a test script
// (window.n64webDetScript, "vi:port:buttons:x:y;" entries, each holding until the next for that port), or the live
// devices sampled at the frame advance.
namespace {
struct LatchedInput { uint16_t buttons = 0; float x = 0, y = 0; bool connected = false; };
LatchedInput g_latched[4];
bool (*g_live)(int, uint16_t*, float*, float*) = nullptr;
struct ScriptEntry { uint64_t vi; int port; uint16_t buttons; float x, y; };
std::vector<ScriptEntry> g_script;
size_t g_script_next = 0;
bool g_script_loaded = false;

void load_script_if_any(uint64_t vi) {
    // The test plan sets the script while the game boots; looked for during the first frames only (each look waits on
    // the page's thread).
    if (g_script_loaded || vi >= 600) return;
    char buf[65536];
    const int n = MAIN_THREAD_EM_ASM_INT({
        const s = globalThis.n64webDetScript || '';
        const b = new TextEncoder().encode(s); const k = Math.min(b.length, $1 - 1);
        HEAPU8.set(b.subarray(0, k), $0); HEAPU8[$0 + k] = 0; return k;
    }, buf, (int)sizeof(buf));
    if (n <= 0) return;
    g_script_loaded = true;
    for (char* tok = strtok(buf, ";"); tok; tok = strtok(nullptr, ";")) {
        unsigned long long vi; int port; unsigned buttons; float x = 0, y = 0;
        if (sscanf(tok, "%llu:%d:%x:%f:%f", &vi, &port, &buttons, &x, &y) >= 3 && port >= 0 && port < 4)
            g_script.push_back({ vi, port, (uint16_t)buttons, x, y });
    }
    fprintf(stderr, "[det] input script: %zu entries\n", g_script.size());
}

void latch_live() {
    if (g_live == nullptr) return;
    for (int port = 0; port < 4; port++) {
        LatchedInput in;
        in.connected = g_live(port, &in.buttons, &in.x, &in.y);
        g_latched[port] = in;
    }
}
}

// ---- Online: both players' inputs, frame by frame --------------------------------------------------------------
// Each page runs the whole game from its boot; only the controllers travel. The input a page samples at frame f is used
// at frame f + delay on both pages, so it has <delay> frames to reach the other page, and a frame waits until the other
// player's input for it is here. Frames below <delay> are neutral on both. Host = controller 1, guest = controller 2.
// The page side (n64webNet in site/retro.html) carries the inputs and compares the two games' hashes.
namespace net {
constexpr uint64_t kHist = 1024;
struct Slot { std::atomic<int64_t> frame{-1}; uint16_t buttons = 0; float x = 0, y = 0; };
Slot remote[kHist], local[kHist];
std::atomic<int> state{0}; // 0 off, 1 the page asked for online (frame 0 waits for the partner), 2 playing, 3 ended
int local_port = 0;
uint64_t delay = 4;
bool asked = false;
std::atomic<uint32_t> frame_now{0}, stall_ms{0};

void put(Slot& s, uint64_t f, uint16_t buttons, float x, float y) {
    s.buttons = buttons; s.x = x; s.y = y;
    s.frame.store((int64_t)f, std::memory_order_release);
}
bool take(const Slot& s, uint64_t f, LatchedInput& out) {
    if (s.frame.load(std::memory_order_acquire) != (int64_t)f) return false;
    out = { s.buttons, s.x, s.y, true };
    return true;
}

// Whether the page is in a room: n64webNet is set up by the page before the game boots. Read once.
bool requested() {
    static std::atomic<int> cached{-1};
    int v = cached.load();
    if (v < 0) { v = MAIN_THREAD_EM_ASM_INT({ return globalThis.n64webNet ? 1 : 0; }); cached.store(v); }
    return v == 1;
}

// True when this frame's inputs came from online play.
bool latch(uint64_t vi) {
    if (!asked) {
        asked = true;
        if (requested()) {
            int off = 0;
            state.compare_exchange_strong(off, 1);
            // The game has booted to its first frame: the page can say so.
            MAIN_THREAD_ASYNC_EM_ASM({ if (globalThis.n64webNet && n64webNet.started) n64webNet.started(); });
        }
    }
    frame_now.store((uint32_t)vi, std::memory_order_relaxed);
    if (state.load() == 1) {
        fprintf(stderr, "[net] frame %llu: waiting for the other player\n", (unsigned long long)vi);
        while (state.load() == 1) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    const int st = state.load();
    if (st == 0) return false;
    LatchedInput mine{ 0, 0, 0, true }, theirs{ 0, 0, 0, true };
    if (st == 2) {
        LatchedInput in;
        if (g_live) g_live(0, &in.buttons, &in.x, &in.y);
        const uint64_t f = vi + delay;
        put(local[f % kHist], f, in.buttons, in.x, in.y);
        MAIN_THREAD_ASYNC_EM_ASM({ if (globalThis.n64webNet) n64webNet.local($0, $1, $2, $3); }, (int)f, (int)in.buttons, in.x, in.y);
        if (vi >= delay) {
            take(local[vi % kHist], vi, mine);
            if (!take(remote[vi % kHist], vi, theirs)) {
                const auto t0 = std::chrono::steady_clock::now();
                while (state.load() == 2 && !take(remote[vi % kHist], vi, theirs))
                    std::this_thread::sleep_for(std::chrono::microseconds(500));
                stall_ms.fetch_add((uint32_t)std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - t0).count());
            }
        }
    }
    if (state.load() == 3) {
        // The other player left: this one plays on, the other controller stays plugged in, untouched.
        mine = {}; mine.connected = true;
        if (g_live) g_live(0, &mine.buttons, &mine.x, &mine.y);
        theirs = { 0, 0, 0, true };
    }
    g_latched[local_port] = mine;
    g_latched[1 - local_port] = theirs;
    g_latched[2] = {}; g_latched[3] = {};
    return true;
}
}

// Online, controller 2 is plugged in from the boot on, on both pages: the game asks which controllers exist once, at
// boot, and only then offers its 2 player modes.
extern "C" bool n64web_det_port_present(int port) { return port == 1 && net::requested(); }

extern "C" EMSCRIPTEN_KEEPALIVE void n64web_net_begin(int local_port, int delay) {
    net::local_port = local_port == 1 ? 1 : 0;
    net::delay = (uint64_t)(delay < 1 ? 1 : delay > 30 ? 30 : delay);
    fprintf(stderr, "[net] online: controller %d, delay %d frames\n", net::local_port + 1, (int)net::delay);
    net::state.store(2);
}
extern "C" EMSCRIPTEN_KEEPALIVE void n64web_net_remote(int frame, int buttons, float x, float y) {
    if (frame < 0) return;
    net::put(net::remote[(uint64_t)frame % net::kHist], (uint64_t)frame, (uint16_t)buttons, x, y);
}
extern "C" EMSCRIPTEN_KEEPALIVE void n64web_net_end() {
    if (net::state.load() != 0) net::state.store(3);
}
extern "C" EMSCRIPTEN_KEEPALIVE int n64web_net_frame() { return (int)net::frame_now.load(); }
extern "C" EMSCRIPTEN_KEEPALIVE int n64web_net_stall_ms() { return (int)net::stall_ms.load(); }

namespace {
void latch_inputs(uint64_t vi) {
    if (net::latch(vi)) return;
    load_script_if_any(vi);
    if (g_script_loaded) {
        g_latched[0].connected = true;
        while (g_script_next < g_script.size() && g_script[g_script_next].vi <= vi) {
            const ScriptEntry& e = g_script[g_script_next++];
            g_latched[e.port] = { e.buttons, e.x, e.y, true };
        }
        return;
    }
    latch_live();
}
}

extern "C" bool n64web_det_input(int port, uint16_t* buttons, float* x, float* y,
                                 bool (*live)(int, uint16_t*, float*, float*)) {
    g_live = live;
    if (port < 0 || port >= 4) return false;
    *buttons = g_latched[port].buttons; *x = g_latched[port].x; *y = g_latched[port].y;
    return g_latched[port].connected || port == 0;
}

// RDRAM hash without the runtime's own host pointers: it keeps each OSThread's host context pointer in the thread
// (OSThread+0x20, a wasm heap address the game never reads), and those differ between runs.
static uint64_t game_hash(const uint8_t* rdram, uint32_t start, uint32_t size) {
    static std::vector<uint32_t> copy;
    copy.assign(reinterpret_cast<const uint32_t*>(rdram + start), reinterpret_cast<const uint32_t*>(rdram + start + size));
    for (size_t i = 2; i + 1 < copy.size(); i++) {
        const uint32_t v = copy[i];
        if (v >= 0x01000000u && (v >> 24) != 0x80 && copy[i - 1] == 0 && copy[i - 2] == 0 && (copy[i + 1] >> 24) == 0x80) copy[i] = 0;
    }
    return XXH3_64bits(copy.data(), copy.size() * 4);
}

// Called by the runtime right before video frame <vi> advances, with every game thread waiting: a deterministic point.
extern "C" void n64web_det_on_vi(uint8_t* rdram, uint64_t vi) {
    if (rdram == nullptr) return;
    latch_inputs(vi);
    if ((g_latched[0].buttons | g_latched[1].buttons) != 0 && vi % 30 == 0)
        fprintf(stderr, "[det] input vi=%llu p0=%04x p1=%04x\n", (unsigned long long)vi, g_latched[0].buttons, g_latched[1].buttons);
    // Memory: the top of the heap (what the page has really taken of its fixed 1.5 GB) and what is in use now.
    if (vi % 600 == 0) {
        const struct mallinfo mi = mallinfo();
        fprintf(stderr, "[mem] vi=%llu heap_top=%u MB in_use=%u MB\n", (unsigned long long)vi,
                (unsigned)((uintptr_t)sbrk(0) >> 20), (unsigned)((size_t)mi.uordblks >> 20));
    }
    // Test runs: which MB of the 1 GB RDRAM region the game has written past the console's 8 MB (how much the region
    // could shrink).
    if (g_script_loaded && (vi == 6000 || vi == 9000)) {
        std::string used;
        int run_start = -1, last = -1;
        for (int mb = 8; mb <= 1024; mb++) {
            bool touched = false;
            if (mb < 1024) {
                const uint64_t* w = reinterpret_cast<const uint64_t*>(rdram + (size_t)mb * 0x100000);
                for (size_t i = 0; i < 0x100000 / 8; i++) if (w[i]) { touched = true; break; }
            }
            if (touched && run_start < 0) run_start = mb;
            if (!touched && run_start >= 0) { used += std::to_string(run_start) + "-" + std::to_string(mb - 1) + " "; run_start = -1; }
            if (touched) last = mb;
        }
        fprintf(stderr, "[mem] vi=%llu written MB past 8: %s(highest %d)\n", (unsigned long long)vi, used.c_str(), last);
    }
    const bool online = net::state.load() == 2;
    if (g_script_loaded ? (vi < 300 || vi % 60 == 0) : (vi % 600 == 0 || (online && vi % 60 == 0))) {
        const uint64_t h = game_hash(rdram, 0, 8 * 1024 * 1024);
        // Online: the two pages compare this every second; a difference means the games went apart.
        if (online) MAIN_THREAD_ASYNC_EM_ASM({ if (globalThis.n64webNet) n64webNet.hash($0, $1, $2); },
                                             (int)vi, (double)(uint32_t)(h >> 32), (double)(uint32_t)h);
        // Which 128 KB blocks differ, for test runs only (another pass over RDRAM).
        char map[65] = "-";
        if (g_script_loaded) {
            for (int b = 0; b < 64; b++) map[b] = "0123456789abcdef"[game_hash(rdram, b * 0x20000, 0x20000) & 15];
            map[64] = 0;
        }
        fprintf(stderr, "[det] vi=%llu hash=%016llx map=%s\n", (unsigned long long)vi, (unsigned long long)h, map);
    }
}
#endif

#ifdef N64WEB_DET
// The co-simulation bridge (the Ares oracle) tracks which recomp context is live; there is no oracle on the page.
extern "C" void psr_cosim_set_active_context(unsigned char*, void*) {}
#endif
