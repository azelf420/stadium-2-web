# Pokémon Stadium 2 (michiiik/pokemonStadiumGSRecomp) as a page: WebAssembly + WebGPU through N64Recomp-browser.
# Configure from games/stadium2/web (a folder whose CMakeLists.txt links here) with emcmake. The game's own
# CMakeLists.txt (desktop) is left as it is. Generated code comes from tools/s2_* (generated_web, 227 MB of C).
cmake_minimum_required(VERSION 3.20)
project(PokemonStadiumGSWeb LANGUAGES C CXX)
set(CMAKE_C_STANDARD 17)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if (NOT EMSCRIPTEN)
    message(FATAL_ERROR "This is the web build: configure it with emcmake cmake.")
endif()

get_filename_component(PORT_DIR "${CMAKE_CURRENT_LIST_FILE}" REALPATH)
get_filename_component(PORT_DIR "${PORT_DIR}" DIRECTORY)
get_filename_component(S2 "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(KIT ${S2}/lib/N64Recomp-browser)
set(RT ${S2}/lib/N64ModernRuntime)
set(N64MODERN_RUNTIME_ROOT ${RT})

if (CMAKE_VERSION VERSION_GREATER_EQUAL "3.24.0")
    cmake_policy(SET CMP0135 NEW)
endif()

# Threads (SharedArrayBuffer), wasm exceptions (the runtime ends a game thread by throwing), wasm SIMD.
add_compile_options(-pthread -fwasm-exceptions -msimd128 -mtail-call "-DXXH_HAS_INCLUDE(x)=0")
add_link_options(-pthread -fwasm-exceptions -mtail-call)
include(${KIT}/frontend/build_speed.cmake)

# RT64 at the kit's base commit with the kit's patches (lib/rt64-web -> games/rt64): WebGPU via plume.
set(RT64_STATIC TRUE)
set(RT64_PREBUILT_SHADER_LIST ${PORT_DIR}/rt64_shaders.txt)
add_compile_definitions(HLSL_CPU)
add_subdirectory(${S2}/lib/rt64-web ${CMAKE_BINARY_DIR}/rt64)
target_include_directories(rt64 PRIVATE ${CMAKE_BINARY_DIR}/rt64/src)

set(BUILD_SHARED_LIBS OFF)
add_subdirectory(${RT} ${CMAKE_BINARY_DIR}/N64ModernRuntime)
if (TARGET fmt)
    target_compile_options(fmt PRIVATE -include cstdlib)
endif()

# The game's replacements of runtime parts, as its desktop build does.
get_target_property(LIBRECOMP_SOURCES librecomp SOURCES)
list(REMOVE_ITEM LIBRECOMP_SOURCES "${RT}/librecomp/src/pi.cpp" "${RT}/librecomp/src/ai.cpp")
set_property(TARGET librecomp PROPERTY SOURCES "${LIBRECOMP_SOURCES}")
target_sources(librecomp PRIVATE ${S2}/mac_pi.cpp ${S2}/mac_ai.cpp)
get_target_property(ULTRAMODERN_SOURCES ultramodern SOURCES)
list(FILTER ULTRAMODERN_SOURCES EXCLUDE REGEX "/mesgqueue\\.cpp$")
set_property(TARGET ultramodern PROPERTY SOURCES "${ULTRAMODERN_SOURCES}")
target_sources(ultramodern PRIVATE ${S2}/mac_mesgqueue.cpp)

# Deterministic stepping (the runtime's co-simulation mode): video frames advance only on tokens and only when every game
# thread waits, and RCP events are delivered at fixed points in simulated time. The base for 2 player online lockstep.
option(N64WEB_DET "Build the runtime with deterministic VI stepping (N64_COSIM)" OFF)
if (N64WEB_DET)
    target_compile_definitions(ultramodern PRIVATE N64_COSIM)
    target_compile_definitions(librecomp PRIVATE N64_COSIM)
endif()

add_subdirectory(${KIT}/frontend ${CMAKE_BINARY_DIR}/web_frontend)
add_subdirectory(${KIT}/renderer ${CMAKE_BINARY_DIR}/web_renderer)

# The recompiled game.
add_library(RecompiledFuncs STATIC)
file(GLOB FUNC_C_SOURCES CONFIGURE_DEPENDS ${S2}/generated_web/*.c)
target_sources(RecompiledFuncs PRIVATE ${FUNC_C_SOURCES})
target_compile_options(RecompiledFuncs PRIVATE -fno-strict-aliasing -Wno-unused-variable -Wno-unused-label
    -Werror=implicit-function-declaration "SHELL:-include ${PORT_DIR}/web_hook_decls.h")
target_include_directories(RecompiledFuncs PRIVATE ${S2}/include ${RT}/ultramodern/include ${RT}/librecomp/include
    ${RT}/N64Recomp/include ${S2}/generated_web)

add_executable(PokemonStadiumGSRecomp
    ${S2}/src/main/main.cpp
    ${S2}/mac_post_mortem_stub.cpp
    ${S2}/src/main/register_overlays.cpp
    ${S2}/src/main/rsp_aspmain_hook.cpp
    ${S2}/src/main/aspmain_replay.cpp
    ${S2}/src/main/aspmain_refint.cpp
    ${S2}/src/main/transfer_pak.cpp
    ${S2}/src/main/gb_audio.cpp
    ${S2}/src/main/input_bindings.cpp
    ${S2}/src/main/audio_host_probe.cpp
    ${S2}/extras_macos.c
    ${S2}/mac_link_shims.c
    ${S2}/generated_web/lookup.cpp
    ${S2}/rsp/aspMain.cpp
    ${S2}/rsp/aspMain_ps2.cpp
    ${S2}/rsp/gbTowerMain.cpp
    ${S2}/rsp/gbTowerColorMain.cpp
    ${S2}/rsp/njpgdspMain.cpp
    ${PORT_DIR}/web_glue.cpp
    ${PORT_DIR}/web_det.cpp
    ${PORT_DIR}/../n64gl/gl_renderer.cpp
)
target_include_directories(PokemonStadiumGSRecomp PRIVATE
    ${S2}/include ${S2}/src/main ${S2}/generated_web
    ${RT}/ultramodern/include ${RT}/librecomp/include ${RT}/N64Recomp/include ${RT}/thirdparty/concurrentqueue ${RT}/thirdparty/xxHash
    ${S2}/lib/rt64-web/src ${S2}/lib/rt64-web/src/contrib ${S2}/lib/rt64-web/src/contrib/hlslpp/include
    ${S2}/lib/rt64-web/src/rhi ${S2}/lib/rt64-web/src/render
    ${CMAKE_CURRENT_BINARY_DIR})
target_compile_options(PokemonStadiumGSRecomp PRIVATE -fno-strict-aliasing -fms-extensions -sUSE_SDL=2)
if (N64WEB_DET)
    target_compile_definitions(PokemonStadiumGSRecomp PRIVATE N64_COSIM N64WEB_DET)
endif()
target_link_libraries(PokemonStadiumGSRecomp PRIVATE RecompiledFuncs librecomp ultramodern n64recomp_browser_renderer
    n64recomp_browser_file_picker)
# Neutral file names on the web: game.html, game.js, game.wasm, game.data.
set_target_properties(PokemonStadiumGSRecomp PROPERTIES OUTPUT_NAME game)
n64recomp_browser_frontend_page(PokemonStadiumGSRecomp)
# n64gl, the light WebGL2 renderer (ports/n64gl): its page side runs on the page's thread.
target_link_options(PokemonStadiumGSRecomp PRIVATE "SHELL:--pre-js ${PORT_DIR}/../n64gl/n64gl.js")
set_property(TARGET PokemonStadiumGSRecomp APPEND PROPERTY LINK_DEPENDS ${PORT_DIR}/../n64gl/n64gl.js)
target_link_options(PokemonStadiumGSRecomp PRIVATE
    "SHELL:--preload-file ${S2}/assets@/assets"
    -sINITIAL_MEMORY=1536MB)
