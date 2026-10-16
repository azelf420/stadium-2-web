// n64gl's side in the program: an ultramodern renderer that hands each graphics task's display list to n64gl
// (n64gl.js, linked with --pre-js). Its reader runs on the thread that sends the task and reads the list from RDRAM;
// its drawer draws the packets with WebGL2 on the page's thread. A pair of counters in shared memory (lists sent,
// lists drawn) lets the reader wait when the drawer falls 2 lists behind.
// Game-agnostic: any F3DEX2 recomp. The renderer never writes RDRAM, so the game runs the same with it as with RT64
// (lockstep online included).
#include <emscripten.h>
#include <cstdint>
#include <memory>

#include "ultramodern/renderer_context.hpp"
#include "ultramodern/ultra64.h"

namespace {
// Shared with n64gl.js: [0] lists drawn (the reader waits on it), [1] the list to dump (?gldump=<n>), set by the page.
alignas(8) int32_t g_lists_drawn[4] = {};

class N64GLRenderer : public ultramodern::renderer::RendererContext {
public:
    explicit N64GLRenderer(uint8_t* rdram) {
        rdram_ = rdram;
        ok_ = MAIN_THREAD_EM_ASM_INT({ return (typeof n64gl !== 'undefined' && n64gl && n64gl.init($0, $1)) ? 1 : 0; }, rdram, &g_lists_drawn) != 0;
        setup_result = ok_ ? ultramodern::renderer::SetupResult::Success : ultramodern::renderer::SetupResult::GraphicsDeviceNotFound;
    }

    bool valid() override { return ok_; }
    bool update_config(const ultramodern::renderer::GraphicsConfig&, const ultramodern::renderer::GraphicsConfig&) override { return false; }
    void enable_instant_present() override {}

    // The list is read before the task completes (the game may reuse its memory right after); drawing comes later.
    void send_dl(const OSTask* task) override {
        EM_ASM({ n64gl.runTask($0, $1, $2); }, rdram_, (int)(task->t.data_ptr & 0x3FFFFFF), &g_lists_drawn);
    }

    void update_screen() override {
        const ultramodern::renderer::ViRegs* vi = ultramodern::renderer::get_vi_regs();
        MAIN_THREAD_ASYNC_EM_ASM({ n64gl.present($0, $1, $2, $3, $4, $5, $6); },
            (int)vi->VI_STATUS_REG, (int)vi->VI_ORIGIN_REG, (int)vi->VI_WIDTH_REG, (int)vi->VI_X_SCALE_REG,
            (int)vi->VI_Y_SCALE_REG, (int)vi->VI_H_START_REG, (int)vi->VI_V_START_REG);
    }

    void shutdown() override {}
    uint32_t get_display_framerate() const override { return 60; }
    float get_resolution_scale() const override { return 1.0f; }

private:
    bool ok_ = false;
    uint8_t* rdram_ = nullptr;
};
}

namespace n64gl {
    // Whether the page asked for n64gl (globalThis.n64webRenderer === 'gl', or ?renderer=gl).
    bool wanted() {
        return MAIN_THREAD_EM_ASM_INT({
            return (globalThis.n64webRenderer === 'gl' || new URLSearchParams(location.search).get('renderer') === 'gl') ? 1 : 0;
        }) != 0;
    }

    std::unique_ptr<ultramodern::renderer::RendererContext> create_renderer(uint8_t* rdram) {
        return std::make_unique<N64GLRenderer>(rdram);
    }
}
