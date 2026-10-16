# Pokémon Stadium 2 Web

A port of **Pokémon Stadium 2** that runs in the browser: WebAssembly for the game, WebGPU for the graphics, an
AudioWorklet for the sound. No plugin, no install.

**No game data is included.** No ROM, no game code, no extracted files. You need your own copy of the game
(US version) to build it or to play it.

**Play it:** https://azelf420.github.io/s2w/ (Chrome or Edge on a computer). The page asks for your ROM the first
time and keeps it in your browser.

## Progress

Done:
- [x] Boots to the title screen, menus and Battle Now!
- [x] 3D battles, stable at about 30 fps (the game's own rate)
- [x] Sound
- [x] Prebuilt shader list, so most first time stutter is gone
- [x] Keyboard controls
- [x] USB and Bluetooth controllers, detected automatically (plug in and press a button)
- [x] Virtual on screen controller on phones and tablets
- [x] Side panel with the controls, in Portuguese or English depending on the browser

In progress:
- [ ] **Online mode**: 2 player battles over the internet
- [ ] Pokémon pictures in the rental list (see `STATUS.md`)

Not tested yet: Gym Leader Castle, mini games, GB Tower, Firefox, Safari, phones.

## Controls

| N64 | Keyboard |
|---|---|
| A | X |
| B | Z |
| START | Enter |
| Z | Shift or Space |
| L / R | Q / E |
| C buttons | I J K L |
| D-Pad | arrow keys |
| Stick | W A S D |

## Build it yourself

You need your own Pokémon Stadium 2 ROM (US, md5 `1561c75d11cedf356a8ddb1a4a5f9d5d`). It is only read on your
machine, during the build. macOS or Linux; every tool is installed inside this folder (`sdk/`).

```
tools/setup_sdk.sh                         # toolchain: Emscripten, LLVM, MIPS binutils, shader tools
tools/fetch_sources.sh                     # downloads the projects this port builds on and applies ports/patches
tools/build_stadium2.sh /path/to/your.z64  # builds the game from your ROM, then the page
```

Then play it locally:

```
node tools/serve.mjs build/stadium2-web 8090 --rom /path/to/your.z64
```

and open http://127.0.0.1:8090 in Chrome. `tools/build_stadium2.sh` was assembled from the steps used during
development and has not been run end to end from a fresh clone yet.

## How it works, in short

The game's original code is translated ahead of time into C, from your ROM, and compiled to WebAssembly together with
a runtime that stands in for the console's operating system and a renderer that draws the console's graphics with
WebGPU. The changes this port makes to the projects it builds on are in `ports/patches/`, one patch per project, with
the exact versions in `ports/pins.txt`. `CHANGELOG.md` lists what was fixed and how it was tested.

## Português

Port do Pokémon Stadium 2 pro navegador. Nenhum arquivo do jogo vem aqui: você precisa da sua própria ROM (US).
Pra jogar, abre https://azelf420.github.io/s2w/ no Chrome e escolhe sua ROM. Pra compilar, roda os três comandos da
seção "Build it yourself" com o caminho da sua ROM. O modo online está em andamento.

## License

GPL-3.0, see `LICENSE`. Credits in `CREDITS.md`.
