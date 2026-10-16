// Stadium 2 on a page: what the desktop build's launcher, debug server, Ares worker and RT64 context give main.cpp,
// for the browser. The launcher is skipped (autoboot), the debug server and Ares oracle don't exist on a page, and
// RT64 draws through N64Recomp-browser's WebGPU renderer.
#include <atomic>
#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <string>

#include "recompui_launcher.h"
#include "debug_server.h"
#include "ares_worker.h"
#include "pokestadium_render.h"
#include "rt64_web_renderer.h"

#ifdef N64WEB_DET
extern "C" void n64web_det_start();
#endif

namespace pkmnstadium::recompui {
    bool run(const char* rom_path_in, char* out_rom, std::size_t out_len) {
        if (rom_path_in && out_len) { std::strncpy(out_rom, rom_path_in, out_len - 1); out_rom[out_len - 1] = 0; }
        return true;
    }
    // Player 1 on the keyboard or the first gamepad; main.cpp's routing only runs once the launcher applies a config.
    PortAssignment port_assignment(int port) {
        PortAssignment a{};
        a.enabled = port == 0;
        a.kind = port == 0 ? DeviceKind::Keyboard : DeviceKind::None;
        return a;
    }
    bool startup_fullscreen() { return false; }
    std::string startup_graphics_api() { return "auto"; }
    int startup_ds_option() { return 1; }
    int startup_msaa() { return 0; }
    std::string startup_audio_device() { return ""; }
}

namespace pkmnstadium::dbg {
    // main() calls this before recomp::start: in lockstep builds, the moment to take frame control, before the game runs.
    void start(int) {
#ifdef N64WEB_DET
        n64web_det_start();
#endif
    }
    void shutdown() {}
    std::atomic<bool>     g_fast_forward{false};
    std::atomic<bool>     g_enable_instant_present_request{false};
    std::atomic<uint64_t> g_vi_ticks{0};
    std::atomic<uint64_t> g_frame_count{0};
    std::atomic<bool>     g_input_override_active{false};
    std::atomic<uint16_t> g_buttons_override{0};
    std::atomic<int>      g_stick_x_override{0};
    std::atomic<int>      g_stick_y_override{0};
    std::atomic<float>    g_audio_volume{1.0f};
    std::atomic<uint64_t> g_send_dl_count{0};
    std::atomic<uint64_t> g_update_screen_count{0};
    std::atomic<uint64_t> g_send_dl_audio_count{0};
    std::atomic<uint64_t> g_send_dl_gfx_count{0};
    std::atomic<uint64_t> g_send_dl_other_count{0};
}

namespace pkmnstadium::ares_worker {
    void start() {}
    void shutdown() {}
    void post_job(std::function<void()> job) { job(); }
}

namespace pokestadium::renderer {
    std::unique_ptr<ultramodern::renderer::RendererContext>
    create_render_context(uint8_t* rdram, ultramodern::renderer::WindowHandle, bool) {
#ifdef N64WEB_DET
        n64web_det_start();
#endif
#ifdef N64WEB_DET
        // Render to RAM writes each drawn frame back into RDRAM whenever the GPU finishes it, so its timing differs between
        // two machines. The game's logic doesn't read its frames back, so lockstep builds leave it off.
        return recompweb::create_rt64_renderer(rdram, false);
#else
        return recompweb::create_rt64_renderer(rdram, true);
#endif
    }
}

// The runtime's libtcc JIT tier is compiled out on the page (overlays.cpp's codegen_function returns first), but its
// JitEntry still names TccRecompOutput's destructor, defined with libtcc in N64Recomp's tcc_recompiler.cpp. No
// TccRecompOutput is ever made here, so the members' own destructors are all it needs.
#include "recompiler/tcc_recompiler.h"
N64Recomp::TccRecompOutput::~TccRecompOutput() = default;
N64Recomp::TccRecompOutput& N64Recomp::TccRecompOutput::operator=(TccRecompOutput&& rhs) noexcept {
    func = rhs.func; rhs.func = nullptr;
    error = std::move(rhs.error); source = std::move(rhs.source); code_size = rhs.code_size;
    return *this;
}
