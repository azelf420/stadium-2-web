#!/bin/bash
# Installs the toolchain into sdk/ (idempotent). Usage: tools/setup_sdk.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; SDK="$ROOT/sdk"; mkdir -p "$SDK/src"
J=4
step() { echo; echo "=== [$(date +%H:%M:%S)] $*"; }

step "venv: cmake + ninja"
[ -x "$SDK/venv/bin/cmake" ] || { python3 -m venv "$SDK/venv"; "$SDK/venv/bin/pip" -q install cmake ninja; }
export PATH="$SDK/venv/bin:$PATH"; cmake --version | head -1; ninja --version

step "emsdk 6.0.12"
[ -d "$SDK/emsdk" ] || git clone -q https://github.com/emscripten-core/emsdk.git "$SDK/emsdk"
( cd "$SDK/emsdk" && ./emsdk install 6.0.12 >/dev/null && ./emsdk activate 6.0.12 >/dev/null )
"$SDK/emsdk/upstream/emscripten/emcc" --version | head -1

step "LLVM 20.1.8 (clang + ld.lld for the MIPS patches), only the files needed, streamed"
if [ ! -x "$SDK/llvm/bin/clang" ]; then
  mkdir -p "$SDK/llvm"
  curl -sL "https://github.com/llvm/llvm-project/releases/download/llvmorg-20.1.8/LLVM-20.1.8-macOS-ARM64.tar.xz" \
    | tar -xJf - -C "$SDK/llvm" --strip-components 1 \
      'LLVM-20.1.8-macOS-ARM64/bin/clang' 'LLVM-20.1.8-macOS-ARM64/bin/clang-20' \
      'LLVM-20.1.8-macOS-ARM64/bin/lld' 'LLVM-20.1.8-macOS-ARM64/bin/ld.lld' \
      'LLVM-20.1.8-macOS-ARM64/bin/llvm-objcopy' 'LLVM-20.1.8-macOS-ARM64/lib/clang/20/include'
fi
"$SDK/llvm/bin/clang" --version | head -1; "$SDK/llvm/bin/clang" --print-targets | grep -i mips | head -2

step "naga-cli 30.0.1"
[ -x "$SDK/cargo/bin/naga" ] || "$HOME/.cargo/bin/cargo" install naga-cli --version 30.0.1 --locked --root "$SDK/cargo" -j $J -q
"$SDK/cargo/bin/naga" --version

step "SPIRV-Tools (spirv-opt only)"
if [ ! -x "$SDK/spirv/bin/spirv-opt" ]; then
  [ -d "$SDK/src/SPIRV-Tools" ] || git clone -q --depth 1 https://github.com/KhronosGroup/SPIRV-Tools.git "$SDK/src/SPIRV-Tools"
  [ -d "$SDK/src/SPIRV-Headers" ] || git clone -q --depth 1 https://github.com/KhronosGroup/SPIRV-Headers.git "$SDK/src/SPIRV-Headers"
  cmake -S "$SDK/src/SPIRV-Tools" -B "$SDK/src/spirv-build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DSPIRV-Headers_SOURCE_DIR="$SDK/src/SPIRV-Headers" -DSPIRV_SKIP_TESTS=ON -DSPIRV_SKIP_EXECUTABLES=OFF \
    -DSPIRV_WERROR=OFF -DCMAKE_INSTALL_PREFIX="$SDK/spirv" >/dev/null
  cmake --build "$SDK/src/spirv-build" --target spirv-opt -j $J >/dev/null
  mkdir -p "$SDK/spirv/bin"; cp "$SDK/src/spirv-build/tools/spirv-opt" "$SDK/spirv/bin/"
fi
"$SDK/spirv/bin/spirv-opt" --version | head -1
step "done"
