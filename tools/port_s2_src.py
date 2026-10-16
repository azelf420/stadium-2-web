# Web (Emscripten) changes to Stadium 2's main.cpp and the runtime fork's JIT tier. Idempotent.
import sys
root = sys.argv[1]
def edit(rel, pairs, marker):
    p = f'{root}/{rel}'; s = open(p).read()
    if marker in s: print(rel, 'already ported'); return
    for old, new in pairs:
        assert s.count(old) == 1, (rel, s.count(old), old[:70]); s = s.replace(old, new)
    open(p, 'w').write(s); print(rel, 'ported')

edit('src/main/main.cpp', [
 # The page's persistent HOME (IndexedDB, N64Recomp-browser's persistent_home.js) holds the settings and the ROM copy.
 ('''#elif defined(__ANDROID__)
    const char* internal_storage = SDL_AndroidGetInternalStoragePath();''', '''#elif defined(__EMSCRIPTEN__)
    return std::filesystem::path("/home/web_user");
#elif defined(__ANDROID__)
    const char* internal_storage = SDL_AndroidGetInternalStoragePath();'''),
 # No pre-boot launcher on the page (as on Android): boot straight into the game.
 ('''    const bool autoboot =
#ifdef __ANDROID__
        true;''', '''    const bool autoboot =
#if defined(__ANDROID__) || defined(__EMSCRIPTEN__)
        true;'''),
 # The ROM comes from the page's file picker, copied into HOME so later visits find it as baserom.z64.
 ('''#else
            std::fprintf(stderr, "[PSR] no file picker on this platform; pass ROM path on the command line.\\n");
            return false;
#endif''', '''#elif defined(__EMSCRIPTEN__)
            std::fprintf(stderr, "[PSR] choose your Pokemon Stadium 2 (US) ROM\\n");
            auto picked = n64recomp_browser::pick_files(false, ".z64,.n64,.v64");
            if (picked.empty()) return false;
            std::error_code ec;
            const auto saved = exe_dir / "baserom.z64";
            std::filesystem::copy_file(picked[0], saved, std::filesystem::copy_options::overwrite_existing, ec);
            out = ec ? picked[0] : saved;
            return true;
#else
            std::fprintf(stderr, "[PSR] no file picker on this platform; pass ROM path on the command line.\\n");
            return false;
#endif'''),
 ('''#include "recompui_launcher.h"''', '''#include "recompui_launcher.h"
#ifdef __EMSCRIPTEN__
#include "file_picker.h"
#endif'''),
], 'n64recomp_browser::pick_files')

edit('lib/N64ModernRuntime/librecomp/src/overlays.cpp', [
 ('''                                       std::string& err) {
    using namespace N64Recomp;''', '''                                       std::string& err) {
#if defined(__EMSCRIPTEN__)
    // WebAssembly can't run code made at run time: no libtcc tier, the interpreter floor runs it instead.
    (void)ctx; (void)vram; (void)entry_out; (void)out_code_size;
    err = "no JIT in WebAssembly";
    return nullptr;
#endif
    using namespace N64Recomp;'''),
], 'no JIT in WebAssembly')

# The kit's renderer also implements send_dummy_workload (newer upstream ultramodern); the fork's RendererContext lacks
# it, so give the base class a do-nothing virtual for it to override. The fork never calls it.
edit('lib/N64ModernRuntime/ultramodern/include/ultramodern/renderer_context.hpp', [
 ('''                virtual void send_dl(const OSTask* task) = 0;''', '''                virtual void send_dl(const OSTask* task) = 0;
                virtual void send_dummy_workload(uint32_t fb_address) { (void)fb_address; }'''),
], 'send_dummy_workload')

edit('src/main/main.cpp', [
 # On the page the window is SDL's canvas window (ultramodern's WindowHandle is SDL_Window* there, as on Android).
 ('''#elif defined(__ANDROID__)
    return ultramodern::renderer::WindowHandle{ g_window };''', '''#elif defined(__ANDROID__) || defined(__EMSCRIPTEN__)
    return ultramodern::renderer::WindowHandle{ g_window };'''),
 # The page's assets are preloaded at /assets; HOME (IndexedDB) is mounted over /home/web_user, so link them in.
 ('''#elif defined(__EMSCRIPTEN__)
    return std::filesystem::path("/home/web_user");''', '''#elif defined(__EMSCRIPTEN__)
    static const bool assets_linked = [] {
        std::error_code ec;
        if (!std::filesystem::exists("/home/web_user/assets", ec)) {
            std::filesystem::create_directory_symlink("/assets", "/home/web_user/assets", ec);
        }
        return true;
    }();
    (void)assets_linked;
    return std::filesystem::path("/home/web_user");'''),
], 'defined(__ANDROID__) || defined(__EMSCRIPTEN__)\n    return ultramodern::renderer::WindowHandle')

# Local play: when the page's server offers the ROM at /baserom.z64 (tools/serve.mjs --rom), take it without asking.
# The game's main() runs on a pthread (PROXY_TO_PTHREAD), where a synchronous XHR is allowed.
edit('src/main/main.cpp', [
 ('''#elif defined(__EMSCRIPTEN__)
            std::fprintf(stderr, "[PSR] choose your Pokemon Stadium 2 (US) ROM\\n");''', '''#elif defined(__EMSCRIPTEN__)
            {
                std::vector<uint8_t> served = psr_web_fetch_served_rom();
                if (!served.empty()) {
                    const auto saved = exe_dir / "baserom.z64";
                    std::ofstream f(saved, std::ios::binary | std::ios::trunc);
                    f.write(reinterpret_cast<const char*>(served.data()), std::streamsize(served.size()));
                    f.close();
                    std::fprintf(stderr, "[PSR] ROM loaded from the page's server (%zu bytes)\\n", served.size());
                    out = saved;
                    return true;
                }
            }
            std::fprintf(stderr, "[PSR] choose your Pokemon Stadium 2 (US) ROM\\n");'''),
 ('''#ifdef __EMSCRIPTEN__
#include "file_picker.h"
#endif''', '''#ifdef __EMSCRIPTEN__
#include "file_picker.h"
#include <emscripten.h>
// The ROM the local server offers at /baserom.z64, or nothing (a 404, or a host that doesn't).
EM_JS(int, psr_web_served_rom_size, (), {
    try {
        const x = new XMLHttpRequest(); x.open('GET', '/baserom.z64', false); x.responseType = 'arraybuffer'; x.send();
        if (x.status !== 200 || !x.response) return 0;
        globalThis.psrServedRom = new Uint8Array(x.response);
        return globalThis.psrServedRom.length;
    } catch (e) { return 0; }
});
EM_JS(void, psr_web_served_rom_copy, (uint8_t* dst), {
    HEAPU8.set(globalThis.psrServedRom, dst); globalThis.psrServedRom = null;
});
static std::vector<uint8_t> psr_web_fetch_served_rom() {
    std::vector<uint8_t> out;
    const int size = psr_web_served_rom_size();
    if (size > 0) { out.resize(size_t(size)); psr_web_served_rom_copy(out.data()); }
    return out;
}
#endif'''),
], 'psr_web_fetch_served_rom')

# Sound on the page: keep the game's bridge (resampler + fill controller) and pull it like the native WASAPI path does
# (psr_audio_fill_f32), into N64Recomp-browser's AudioWorklet output. SDL2's port plays from the page's thread, which
# WebGPU keeps busy, so its sound breaks up there.
edit('src/main/main.cpp', [
 ('''static void reset_audio(uint32_t output_freq) {
    bool use_bridge = audio_bridge_enabled();''', '''#ifdef __EMSCRIPTEN__
// Keeps the AudioWorklet's ring about 40 ms ahead, pulling the bridge in 256-frame pieces, as a host audio thread would.
static void psr_web_audio_pump() {
    std::vector<float> buf(256 * output_channels);
    const size_t target = output_sample_rate / 25;
    for (;;) {
        while (n64recomp_browser::audio::queued_frames() < target) {
            psr_audio_fill_f32(buf.data(), 256);
            n64recomp_browser::audio::queue(buf.data(), 256);
        }
        SDL_Delay(2);
    }
}
#endif

static void reset_audio(uint32_t output_freq) {
    bool use_bridge = audio_bridge_enabled();
#ifdef __EMSCRIPTEN__
    if (use_bridge) {
        static bool started = false;
        output_sample_rate = n64recomp_browser::audio::open(output_channels);
        update_audio_converter();
        if (!g_audio_mtx) g_audio_mtx = SDL_CreateMutex();
        SDL_LockMutex(g_audio_mtx);
        bridge_reinit_locked();
        SDL_UnlockMutex(g_audio_mtx);
        if (!started) {
            started = true;
            std::thread(psr_web_audio_pump).detach();
        }
        fprintf(stderr, "[PSR][audio] web AudioWorklet output  src=%u -> host=%u  ready=%d\\n",
                sample_rate, output_sample_rate, g_bridge_ready);
        return;  // no SDL audio device on the page
    }
#endif'''),
 ('''#include "file_picker.h"
#include <emscripten.h>''', '''#include "file_picker.h"
#include "audio_output.h"
#include <emscripten.h>
#include <thread>'''),
], 'psr_web_audio_pump')

# Stadium 2 has 652 decompressed fragment variants (frag_8FF00000: 651 + 1), which the codegen links at
# 0xC0000000 + i * 1 MB, up to 0xE8B00000. The runtime's synthetic pool stopped at 0xE0000000 (512 buckets, sized for
# Stadium 1's ~279), so the last 140 variants were never candidates: their fragments stayed unregistered and ran in
# the interpreter (battle lag). 0xC0000000..0xF0000000 (KSEG2/KSEG3, unused by N64 software) holds 768.
edit('lib/N64ModernRuntime/librecomp/src/overlays.cpp', [
 ('''static constexpr uint32_t kSyntheticPoolEnd   = 0xE0000000u;''',
  '''static constexpr uint32_t kSyntheticPoolEnd   = 0xE8B00000u; // 651 buckets: Stadium 2's frag_8FF00000 variants (slot 651, frag_81000000's id-0 variant, untested upstream and crashes battles, stays out)'''),
], 'kSyntheticPoolEnd   = 0xE8B00000u')

# Several instances of one fragment id live at once: id 0xEF (the 0x8FF00000 stream) is per-Pokemon code, and a 3-on-3
# battle loads six of them at six bases. "Issue #9" kept ONE live range per id and erased the previous instance's
# func_map entries whenever the id loaded at a different base, so the five other Pokemon's code vanished and the next
# call into it missed (interior entry -> interpreter -> abort). Keep every live instance of an id, and supersede only
# the ones the new instance actually overlaps in RDRAM.
edit('lib/N64ModernRuntime/librecomp/src/overlays.cpp', [
 ('''static std::unordered_map<uint32_t, std::pair<uint32_t, uint32_t>> s_frag_live_range{};''',
  '''static std::unordered_map<uint32_t, std::vector<std::pair<uint32_t, uint32_t>>> s_frag_live_range{};
// Erases (from func_map) and forgets the live instances of `id` that overlap [base, base+size) at another base; returns
// how many entries were erased. Instances elsewhere in RDRAM stay registered: they are still resident and running.
static uint32_t frag_supersede_overlapping(uint32_t id, uint32_t base, uint32_t size) {
    auto it = s_frag_live_range.find(id);
    if (it == s_frag_live_range.end()) return 0;
    uint32_t erased = 0;
    auto& live = it->second;
    for (auto r = live.begin(); r != live.end();) {
        const bool overlaps = r->first < base + size && base < r->first + r->second;
        if (r->first != base && overlaps) {
            const uint32_t n = frag_range_erase(r->first, r->second);
            if (n) {
                fprintf(stderr, "[frag-unreg] id=%u superseded 0x%08X(size0x%X): erased %u stale func_map entries (new base 0x%08X, overlapping)\\n",
                        id, r->first, r->second, n, base);
                fflush(stderr);
            }
            erased += n;
            r = live.erase(r);
        } else if (r->first == base) {
            r = live.erase(r);
        } else {
            ++r;
        }
    }
    return erased;
}
static void frag_live_add(uint32_t id, uint32_t base, uint32_t size) {
    s_frag_live_range[id].emplace_back(base, size);
}'''),
 ('''        if (frag_unreg_enabled()) {
            auto prev = s_frag_live_range.find(id);
            if (prev != s_frag_live_range.end() && prev->second.first != (uint32_t)fragment_ptr) {
                uint32_t erased = frag_range_erase(prev->second.first, prev->second.second);
                if (erased) {
                    fprintf(stderr, "[frag-unreg] id=%u superseded 0x%08X(size0x%X): erased %u stale func_map entries (no-bind new base 0x%08X)\\n",
                            id, prev->second.first, prev->second.second, erased, (uint32_t)fragment_ptr);
                    fflush(stderr);
                }
            }
        }
        if (frag_size_in_ram != 0) {
            s_frag_live_range[id] = { (uint32_t)fragment_ptr, frag_size_in_ram };
        }''', '''        if (frag_unreg_enabled()) {
            frag_supersede_overlapping(id, (uint32_t)fragment_ptr, frag_size_in_ram ? frag_size_in_ram : 1);
        }
        if (frag_size_in_ram != 0) {
            frag_live_add(id, (uint32_t)fragment_ptr, frag_size_in_ram);
        }'''),
 ('''    if (frag_unreg_enabled()) {
        auto prev = s_frag_live_range.find(id);
        if (prev != s_frag_live_range.end() && prev->second.first != (uint32_t)fragment_ptr) {
            uint32_t erased = frag_range_erase(prev->second.first, prev->second.second);
            if (erased) {
                fprintf(stderr, "[frag-unreg] id=%u superseded 0x%08X(size0x%X): erased %u stale func_map entries (new base 0x%08X)\\n",
                        id, prev->second.first, prev->second.second, erased, (uint32_t)fragment_ptr);
                fflush(stderr);
            }
        }
    }''', '''    if (frag_unreg_enabled()) {
        frag_supersede_overlapping(id, (uint32_t)fragment_ptr, (uint32_t)section.size);
    }'''),
 ('''    s_frag_live_range[id] = { (uint32_t)fragment_ptr, (uint32_t)section.size };''',
  '''    frag_live_add(id, (uint32_t)fragment_ptr, (uint32_t)section.size);'''),
], 'frag_supersede_overlapping')

# Diagnostic: log the first RSP JPEG tasks (type, data pointer and size, output buffer).
edit('src/main/main.cpp', [
 ('''        case M_NJPEGTASK: return njpgdspMain;''', '''        case M_NJPEGTASK: {
            static std::atomic<int> n_jpeg{0};
            const int n = n_jpeg.fetch_add(1);
            if (n < 4) {
                fprintf(stderr, "[n64web-jpeg] #%d data_ptr=0x%08X data_size=0x%X output=0x%08X output_size=0x%X yield=0x%08X flags=0x%X\\n",
                        n, (uint32_t)task->t.data_ptr, (uint32_t)task->t.data_size, (uint32_t)task->t.output_buff,
                        (uint32_t)task->t.output_buff_size, (uint32_t)task->t.yield_data_ptr, (uint32_t)task->t.flags);
                const uint32_t* d = reinterpret_cast<const uint32_t*>(rdram + (((uint32_t)task->t.data_ptr) & 0x7FFFFF));
                fprintf(stderr, "[n64web-jpeg]   data: %08X %08X %08X %08X %08X %08X %08X %08X\n", d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]);
            }
            return njpgdspMain;
        }'''),
], 'n64web-jpeg')

# The page's tab title (SDL sets document.title from the window's): a neutral name on the web.
edit('src/main/main.cpp', [
 ('''    g_window = SDL_CreateWindow(
        "Pokemon Stadium 2 Recomp",''', '''    g_window = SDL_CreateWindow(
#ifdef __EMSCRIPTEN__
        "n64web",
#else
        "Pokemon Stadium 2 Recomp",
#endif'''),
], '"n64web",')

# A ROM address the player gives the page once (?rom=<url>), kept in that browser's localStorage, fetched like the local
# server's /baserom.z64. The address is never part of the page: whoever opens it without one gets the file picker.
edit('src/main/main.cpp', [
 ('''static std::vector<uint8_t> psr_web_fetch_served_rom() {
    std::vector<uint8_t> out;
    const int size = psr_web_served_rom_size();''', '''// The ROM address from ?rom= (saved to localStorage) or saved earlier, read on the page's thread; its length, or 0.
static int psr_web_rom_url(char* buf, int cap) {
    return MAIN_THREAD_EM_ASM_INT({
        let u = '';
        try {
            const q = new URLSearchParams(location.search).get('rom');
            if (q) { localStorage.setItem('n64web-rom', q); history.replaceState(null, '', location.pathname); }
            u = q || localStorage.getItem('n64web-rom') || '';
        } catch (e) {}
        const b = new TextEncoder().encode(u);
        const n = Math.min(b.length, $1 - 1);
        HEAPU8.set(b.subarray(0, n), $0); HEAPU8[$0 + n] = 0;
        return n;
    }, buf, cap);
}
EM_JS(int, psr_web_url_rom_size, (const char* url, int len), {
    try {
        const u = new TextDecoder().decode(HEAPU8.slice(url, url + len));
        const x = new XMLHttpRequest(); x.open('GET', u, false); x.responseType = 'arraybuffer'; x.send();
        if (x.status !== 200 || !x.response) return 0;
        globalThis.psrServedRom = new Uint8Array(x.response);
        return globalThis.psrServedRom.length;
    } catch (e) { return 0; }
});
static std::vector<uint8_t> psr_web_fetch_served_rom() {
    std::vector<uint8_t> out;
    int size = psr_web_served_rom_size();
    if (size <= 0) {
        char url[2048];
        const int len = psr_web_rom_url(url, sizeof(url));
        if (len > 0) {
            fprintf(stderr, "[PSR] fetching the ROM from the saved address\\n");
            size = psr_web_url_rom_size(url, len);
        }
    }'''),
], 'psr_web_rom_url')

# A gamepad unplugged while playing is let go, so the next one plugged in (or the same one again) is picked up.
edit('src/main/main.cpp', [
 ('''    } else {
        ensure_pad_open();
    }
}''', '''    } else {
        if (g_pad && !SDL_GameControllerGetAttached(g_pad)) {
            fprintf(stderr, "[input] controller disconnected\\n");
            SDL_GameControllerClose(g_pad);
            g_pad = nullptr;
        }
        ensure_pad_open();
    }
}'''),
], 'controller disconnected')
