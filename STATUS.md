# STATUS (2026-10-16): Stadium 2 rental list icons missing

**What the user sees:** Stadium → (Prime/Poké) Cup → Rental Only: the list shows names/levels but no Pokémon pictures.

**Proven (headless Chrome, `ports/stadium2/rental_plan.json`, `?tex-log`, `[n64web-jpeg]` logs):**
- The renderer is not the cause.
  - The game draws 12 RGBA16 textures (one per visible cell) at 0x55F860 + k·0xCE8. Their RDRAM is all zeros.
  - No render target is ever set there (`[n64web-cimg]`: only the 640-wide framebuffers).
- The pictures come from the game's RSP JPEG path (njpgdsp, M_NJPEGTASK), one MCU group per task, about 60 tasks/s.
  - The tasks stop for good right at the menu → cup screen transition: last task #2999 at about 83 s; 2 runs, same.
  - None run on the rental screen, so the pictures are never decoded.
- Ruled out:
  - YUV decode fixes (ported from mstan's rt64);
  - framebuffer-tile coverage fix;
  - 1x resolution (`?res=1`);
  - the scheduler gate func_8000204C (0x800AB484/0x800AB40C) is not what blocks.

**Likely cause (not yet proven):** the JPEG client thread (func_80003AF0 → func_800039C8 builds the OSTask with its own
1-message queue) waits forever for an SP-done that never reaches it. The game's scheduler yields gfx tasks to run JPEG
or audio; ultramodern has no RSP yield, so a completion is lost or misattributed when gfx and JPEG overlap.

**Next:**
1. Log osSpTaskStartGo / osSpTaskYield / osSpTaskYielded and SP-done events around the stall.
2. See which message the JPEG thread is blocked on (the fork's thread dump / sched_log rings).
3. Fix in the runtime (likely a JPEG-type task completion path).

Not tested on desktop (no native build here), so whether upstream has the same stall is unknown.
