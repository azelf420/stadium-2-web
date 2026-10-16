// Runtime functions that game.toml's hooks call from the recompiled C (librecomp/src/overlays.cpp). The page needs them
// declared: WebAssembly traps a call made through a guessed `int f()` signature.
#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
void librecomp_fragment_input_push(uint32_t input);
uint32_t librecomp_fragment_resolve_exit(uint32_t game_result, uint32_t data_ctx_addr);
#ifdef __cplusplus
}
#endif
