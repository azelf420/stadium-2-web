#!/bin/bash
# Clones the projects this port is built on into games/ at the commits in ports/pins.txt and applies
# ports/patches/*.patch. No ROM is needed for this step.
#   tools/fetch_sources.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; G="$ROOT/games"; P="$ROOT/ports/patches"; mkdir -p "$G"
pin() { awk -v n="$1" '$1==n {print $4}' "$ROOT/ports/pins.txt"; }
url() { awk -v n="$1" '$1==n {print $3}' "$ROOT/ports/pins.txt"; }
dir() { awk -v n="$1" '$1==n {print $2}' "$ROOT/ports/pins.txt"; }
at_pin() {
    local d="$G/$(dir "$1")" c; c="$(pin "$1")"
    git -C "$d" fetch -q origin "$c" 2>/dev/null || git -C "$d" fetch -q --unshallow origin 2>/dev/null || true
    git -C "$d" checkout -q "$c"
}
apply() { local d="$G/$(dir "$1")"; [ -s "$P/$1.patch" ] && git -C "$d" apply --whitespace=nowarn "$P/$1.patch" && echo "patched $1"; }

# RT64 (renderer, WebGPU through plume).
[ -d "$G/rt64" ] || git clone -q "$(url rt64)" "$G/rt64"
at_pin rt64; git -C "$G/rt64" submodule update -q --init --recursive
for n in plume hlslpp; do at_pin "$n"; done
for n in rt64 plume hlslpp; do apply "$n"; done

# Pokemon Stadium 2 project (its optional Ares submodule is skipped: large and not needed).
[ -d "$G/stadium2" ] || git clone -q "$(url stadium2)" "$G/stadium2"
at_pin stadium2
git -C "$G/stadium2" -c submodule.ares-bridge/third_party/ares.update=none submodule update -q --init
for s in lib/N64ModernRuntime n64recomp recomp-ui; do
    git -C "$G/stadium2/$s" -c submodule.ares-bridge/third_party/ares.update=none submodule update -q --init 2>/dev/null || true
done
git -C "$G/stadium2/lib/N64ModernRuntime/N64Recomp" submodule update -q --init lib/ELFIO lib/fmt lib/rabbitizer lib/sljit lib/tomlplusplus
git -C "$G/stadium2/n64recomp" submodule update -q --init lib/ELFIO lib/fmt lib/rabbitizer lib/sljit lib/tomlplusplus
for n in stadium2-n64recomp stadium2-runtime stadium2-runtime-n64recomp; do at_pin "$n"; done
[ -d "$G/stadium2/lib/N64Recomp-browser" ] || git clone -q "$(url n64recomp-browser)" "$G/stadium2/lib/N64Recomp-browser"
git -C "$G/stadium2/lib/N64Recomp-browser" checkout -q "$(pin n64recomp-browser)"
for n in stadium2 stadium2-n64recomp stadium2-runtime stadium2-runtime-n64recomp n64recomp-browser; do apply "$n"; done
ln -sfn ../../rt64 "$G/stadium2/lib/rt64-web"
mkdir -p "$G/stadium2/web" && ln -sfn ../../../ports/stadium2/CMakeLists.txt "$G/stadium2/web/CMakeLists.txt"
echo "sources ready in $G"
