# Changelog

What changed and how it was tested. Measurements come from headless Chrome on an Apple M1 unless said otherwise.

## Online: player 2's controller
- The game checks which controllers are plugged in once, at boot, and only then offers 2 player modes. In a room both
  pages now report controller 2 from the boot on, so 2 player modes open (tested: Game Pak Check shows two
  controllers and Event Battle, a 2 player arena, opens).
- Entering or leaving a room says first that the game restarts, and the room box says "Loading the game..." until it
  is ready.

## Rooms
- Players have a name. In a room the panel shows the room code, who is in it and its owner; the owner can kick the
  other player, and both can leave. A match can't take a new player midway (both games run from boot in step), so
  after the other player leaves the owner gets NEW MATCH, which restarts the game with the same room code.

## Faster start
- The ROM is kept in the browser after the first time (only the US ROM, checked by its SHA-256), whether it was
  picked as a file or came from an address: later visits start without asking or downloading.
- The page's game files are sent gzipped by the asset host: the WebAssembly goes from 51 MB to 12 MB on the wire.

## Online mode (2 players)
- The page has an online mode: create a room, send the link, play. Each page runs the whole game from its own ROM and
  only the controller inputs travel (lockstep), WebRTC between the browsers, with the room server as a fallback.
- The game runs deterministically: video frames advance on tokens when every game thread waits, graphics, sound and
  JPEG tasks complete at fixed points of game time, sound is clocked by video frames, and a busy thread is switched
  after a fixed count of loop jumps instead of a host timer. Two runs with the same inputs are byte identical in the
  console's 8 MB of memory, from boot through menus and a battle (tested twice with scripted inputs).
- Online test on the published page, two browsers on one machine through the room server: 46 of 46 checkpoints
  identical (frames 0 to 2700). When one page closes, the other plays on alone.
- Single player runs on the same build at about 30 fps.

## Controllers and touch
- USB and Bluetooth controllers with the browser's standard layout are picked up while the game runs. Unplugging
  one lets it go, so the next one is taken.
- Phones and tablets get an on screen controller: a virtual standard gamepad the game reads like a real one (analog
  stick, A, B, Z, L, R, START, C buttons, D-Pad). It is plugged in on the first touch, and it was tested by driving
  START and A from the page.

## Side panel
- `ports/stadium2/site/retro.html` is added to the published page by `tools/make_site.py`: the controls, fullscreen,
  hide panel, a visit count kept in the browser and the online mode box. Texts follow
  the browser's language, Portuguese or English.

## Sound
- The game's own audio bridge (resampler and fill control) is kept and pulled into an AudioWorklet about 40 ms ahead.
  Over 3 minutes of battle the output buffer ran dry for about 1 ms in total.

## Battle lag and crashes (bugs of the base project, not of the web)
- The runtime's pool for decompressed code fragments had 512 slots, sized for the first game. This one has 652
  variants, so the per Pokémon code of the last 140 ran in the slow MIPS interpreter during battles. The pool now
  holds the 651 Pokémon fragment variants; the remaining one (a variant of fragment 0) is left out because it crashes
  battles when used.
- Several instances of one fragment id can now live at once: a 3 on 3 battle loads six per Pokémon fragments, and
  registering one used to erase the code of the other five.
- `osSetTime` was called through the wrong signature (the configuration ignores it, so the generated code called the
  runtime's native function with a memory pointer as the time).
- Result: 0 fragments left to the interpreter, about 29.6 fps median, no errors over several minutes of battle.

## Code size
- The recompiler's output was 5 GB of C, which would have been about 1 GB of WebAssembly. Every entry point found
  inside a function was a full copy of that function. They are now dispatch entries of the one function, in two
  passes (`tools/s2_static_dedup.py`), with one shared tail call dispatcher per function (`tools/s2_tc_dispatch.py`).
  Result: 229 MB of C and a 51 MB `.wasm`.

## Graphics
- RT64 runs on WebGPU (N64Recomp-browser). Fixes from the base project's own RT64 fork were brought over: YUV texture
  decoding, the JPEG byte order, the YUV texture rectangle stride, and requiring full coverage before a texture is
  read from a framebuffer.
- A prebuilt list of 132 shaders, recorded by playing the menus and three battles by script
  (`ports/stadium2/shader_plan.json`).

## Page
- The ROM can come from a file picker, or from an address given once with `?rom=<url>` and kept in the browser.
- `tools/make_site.py` points `game.wasm` and `game.data` at an asset host, so the page repository holds no game code.
