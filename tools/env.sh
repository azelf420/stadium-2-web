# source tools/env.sh: every tool from sdk/, nothing global.
_N64WEB="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)"
export N64WEB_ROOT="$_N64WEB"
export PATH="$_N64WEB/sdk/binutils/bin:$_N64WEB/sdk/venv/bin:$_N64WEB/sdk/cargo/bin:$_N64WEB/sdk/spirv/bin:$_N64WEB/sdk/llvm/bin:$PATH"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
if [ -f "$_N64WEB/sdk/emsdk/emsdk_env.sh" ]; then
  export EMSDK_QUIET=1; source "$_N64WEB/sdk/emsdk/emsdk_env.sh" >/dev/null
fi
export MIPS_CC="$_N64WEB/sdk/llvm/bin/clang" MIPS_LD="$_N64WEB/sdk/llvm/bin/ld.lld"
