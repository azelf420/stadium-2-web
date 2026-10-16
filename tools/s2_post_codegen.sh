#!/bin/bash
# After N64Recomp writes games/stadium2/generated_web: the game's own fixups (as its CMake runs them), then web ones.
set -euo pipefail
S2="$(cd "$(dirname "$0")/../games/stadium2" && pwd)"; G="$S2/generated_web"
python3 -I "$S2/tools/fix_fragment20_bounds.py" "$G"
python3 -I "$S2/tools/fix_menu_cursor_relocation.py" "$G"
# game.toml ignores osSetTime, so the C calls osSetTime(rdram, ctx), which is ultramodern's osSetTime(OSTime): on x86
# the clock gets set from a pointer; in WebAssembly it's a signature mismatch. librecomp's osSetTime_recomp is the one.
grep -l "^    osSetTime(rdram, ctx);" "$G"/*.c | while read -r f; do
    sed -i '' 's/^    osSetTime(rdram, ctx);/    osSetTime_recomp(rdram, ctx);/' "$f"; echo "osSetTime -> osSetTime_recomp in $(basename "$f")"; done
sed -i '' 's/^void osSetTime(uint8_t\* rdram, recomp_context\* ctx);/void osSetTime_recomp(uint8_t* rdram, recomp_context* ctx);/' "$G/funcs.h"
