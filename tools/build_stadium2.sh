#!/bin/bash
# Builds the Pokemon Stadium 2 page (build/stadium2-web/game.html) from YOUR ROM (US, md5 1561c75d11cedf356a8ddb1a4a5f9d5d).
#   tools/setup_sdk.sh && tools/fetch_sources.sh && tools/build_stadium2.sh roms/stadium2.us.z64
# The ROM is only read on this machine: it builds the decomp's ELF that N64Recomp translates. Nothing of it is
# written into this repository (games/, build/ and roms/ are outside the whitelist .gitignore).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; S2="$ROOT/games/stadium2"; B="$ROOT/build"; ROM="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
source "$ROOT/tools/env.sh"; mkdir -p "$B"
[ "$(md5 -q "$ROM" 2>/dev/null || md5sum "$ROM" | cut -d' ' -f1)" = 1561c75d11cedf356a8ddb1a4a5f9d5d ] || { echo "not the US ROM"; exit 1; }

# 1. The decomp's ELF (must match the ROM byte for byte).
cp "$ROM" "$S2/baserom.z64"; mkdir -p "$S2/disasm/baseroms/us"; cp "$ROM" "$S2/disasm/baseroms/us/baserom.z64"
( cd "$S2/disasm" && { [ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip -q install -r requirements.txt; }; } \
  && make setup && make extract && make -j4 rom || true )
[ "$(md5 -q "$S2/disasm/build/pokestadiumgs-us.z64" 2>/dev/null || md5sum "$S2/disasm/build/pokestadiumgs-us.z64" | cut -d' ' -f1)" = 1561c75d11cedf356a8ddb1a4a5f9d5d ] \
  || { echo "decomp build does not match"; exit 1; }

# 2. The patched N64Recomp, then the game's C in two passes (static dedup) with the shared tail-call dispatcher.
cmake -S "$S2/n64recomp" -B "$B/n64recomp-s2" -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
ninja -C "$B/n64recomp-s2" -j4 N64Recomp
sed 's/^output_func_path = "generated"/output_func_path = "generated_web"/' "$S2/game.toml" > "$S2/game_web.toml"
export N64RECOMP_STATIC_ENTRIES="$B/stadium2-static-entries.txt" N64RECOMP_SHARED_TC_DISPATCH=1
rm -f "$N64RECOMP_STATIC_ENTRIES"; rm -rf "$S2/generated_web"
( cd "$S2" && "$B/n64recomp-s2/N64Recomp" game_web.toml >/dev/null && "$B/n64recomp-s2/N64Recomp" game_web.toml >/dev/null )
"$ROOT/tools/s2_post_codegen.sh"
ln -sfn generated_web "$S2/generated"

# 3. The page.
embuilder build sdl2-mt freetype-legacysjlj >/dev/null
emcmake cmake -S "$S2/web" -B "$B/stadium2-web" -G Ninja -DCMAKE_BUILD_TYPE=Release -DRT64_NAGA_EXECUTABLE="$(which naga)" -DN64WEB_DET=ON >/dev/null
ninja -C "$B/stadium2-web" -j4
echo "page: $B/stadium2-web/game.html   (play locally: node tools/serve.mjs build/stadium2-web 8090 --rom <your rom>)"
