# AGENTS.md

Rules for anyone (or any coding agent) working on this repository.

1. Never commit ROMs, game code generated from a ROM, extracted assets or decompiled output. The whitelist
   `.gitignore` keeps `roms/`, `games/`, `build*/` and `sdk/` out; do not turn it into a normal ignore list.
2. Changes to the projects this port builds on go in `ports/patches/` (one patch per project) with their commits in
   `ports/pins.txt`.
3. Say "not tested" when something was not run. Record what changed and how it was tested in `CHANGELOG.md`.
4. Single player and offline only, apart from the planned 2 player online mode. No DRM work: bring your own ROM.
