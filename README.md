# ds-recomp

A Nintendo DS emulator running entirely in the browser. ARM9 (ARMv5TE + CP15) and ARM7 (ARMv4T) interpreters written from scratch in TypeScript, two-bus memory map, IPC SYNC + FIFO, DMA, scanline-accurate 2D compositor with text / affine / bitmap BGs + sprites + windows + blending + master brightness, BIOS HLE for the common SWIs, JS-side IRQ-take HLE that bypasses the in-BIOS ARM stub, DS Math coprocessor, VRAM bank router honouring all `VRAMCNT_x` mappings, 16-channel sound mixer (PCM8/PCM16) with Web Audio output, partial 3D engine (GXFIFO + viewport + clip + rasterizer), per-game save-chip protocol (EEPROM 0.5K / 8K, FLASH 1M), TSC2046 touchscreen with pressure, RTC, mic + PM stubs, WiFi register stubs, NSMB FS-thunk assist, and an opt-in WASM Thumb JIT for ARM9.

No prebuilt BIOS, no off-the-shelf cores — the whole stack is TypeScript with TypedArrays.

## Status

12 retail ROMs render visible content (🟢), 6 boot past SDK init but render is partial (🟡), 17 stall early (🔴). Status is best-effort and measured by running each ROM for 1800 frames (30 sec game time) and sampling distinct framebuffer colors at 5 timestamps.

| Tier | ROM examples |
|---|---|
| 🟢 Visible content | Super Mario 64 DS · Brain Training · Cooking Mama · The Simpsons Game · Age of Empires: Mythologies · Spider-Man: Edge of Time · Tony Hawk's Proving Ground · PMD: Blue Rescue Team · Nintendo DS Browser · **LEGO Battles: Ninjago** · **Nintendogs - Labrador** · **The Sims 3** |
| 🟡 Partial render | LEGO Star Wars · LEGO Indiana Jones · NFS ProStreet · Cars · Skate It · Sonic Rush Adventure |
| 🔴 Stalls early | New Super Mario Bros. · Tetris DS · Pokemon Platinum / HG / Pearl / Diamond · Meteos · Apollo Justice · Zelda: Spirit Tracks · GTA Chinatown Wars · SpongeBob · Plants vs. Zombies · others |
| 🧪 PPU regression tests | RockWrestler homebrew + targeted OBJ mosaic / OBJ priority / OBJ mosaic-fuzz ROMs |

DSi-Enhanced titles (Art Academy, Sims 3, Toy Story 3) don't run — DSi-specific hardware is not modelled.

469 vitest cases cover the ARM/Thumb interpreters via the RockWrestler boot-ROM suite, the DS Math coprocessor, ARMv5 saturation + DSP halfword multiplies, DTCM/ITCM virtual-size mirroring + load-mode semantics, IPC SYNC + FIFO + PXI server stubs, IRQ controller corners (write-1-to-clear, cachedPending invariants), DMA channels (immediate / VBlank / HBlank / cardready timing + repeat + increment-reload), timers (prescaler, overflow, cascade), BIOS HLE (Divide, CpuSet, CpuFastSet, BitUnPack, LZ77UnCompReadByCopy16, GetCRC16), NDS header + banner parsers, VRAM bank router for every documented MST/OFFSET combination, text + affine + bitmap BG modes, sprites, windows, blending, master brightness, sound mixer (PCM8/PCM16) including ARM7-IWRAM sample sources, GX 3D command stream basics, CP15 register interactions, the WASM Thumb JIT, and the per-game save-chip protocol table.

## Quick start

```bash
git clone git@github.com:ImLunaHey/ds-recomp.git
cd ds-recomp
npm install
npm run dev
```

Open the URL Vite prints. Put any `.nds` file in `public/` (gitignored — ROMs are never shipped). The library page lists every registered ROM grouped by status; click a card for known issues, then ▶ Play. You can also drag any `.nds` file onto the player to load it ad-hoc.

## UI

Three routes wired with `react-router-dom`:

| Route | Purpose |
|---|---|
| `/` | Library grid: every ROM as a card with status emoji, blurb, known-issue count |
| `/rom/:slug` | Per-ROM detail: full blurb, bulleted known-issues list, ▶ Play button |
| `/play/:slug` | Player: dual canvases, banner + ROM metadata, virtual control pad, drag-drop load, live debug sidebar (CPU/IRQ/PPU/IPC/JIT/sound/DMA), live disasm-at-PC panel, 📸 Snapshot button that downloads a JSON dump of register + bank state |

The `Emulator` instance lives at the App root via `EmuContext` so it survives navigation. Switching ROMs calls `Emulator.reset()` inside `loadRom` to wipe all volatile state without rebuilding the bus graph.

## Controls

Keyboard:

| NDS button | Keyboard |
|---|---|
| A | Z |
| B | X |
| Start | Enter |
| Select | Shift |
| D-pad | Arrow keys |
| L / R | A / S |
| X / Y | Q / W |

Or the on-screen virtual control pad below the screens (Pointer events — works for mouse + touch).

Touch: click/tap the bottom canvas to inject a touchscreen press at that coordinate.

Audio is on by default. The first user gesture (any click or keypress) starts the AudioContext — browser autoplay policy forbids it any earlier.

## Toolbar

| Button | Notes |
|---|---|
| ▶ Run / ⏸ Pause | Frame loop |
| ⟲ Reset | Reload the current ROM |
| 🔊 Audio | Toggle Web Audio output |
| ⚡ JIT | Enable the WASM Thumb basic-block recompiler for ARM9 (~3.5× hot-loop speedup, default off) |
| 📸 Snapshot | Download a JSON dump of PPU + VRAM-banking + CPU + IPC + DMA + sound state — for triage |
| Inject test pattern | Sanity-check the 2D renderer end-to-end |

## Architecture

```
src/
  cpu/
    state.ts        Register file (R0-R15, banked SP/LR/SPSR per mode), CPSR helpers.
    shifter.ts      Barrel shifter (LSL/LSR/ASR/ROR + RRX), immediate + register forms.
    arm.ts          ARM dispatch: data processing, MRS/MSR, branch, BX, LDR/STR, halfword,
                    multiply, swap, LDM/STM, SWI. ARMv5 extensions: CLZ, BLX(1)/(2),
                    LDRD/STRD, MCR/MRC (CP15), CDP/LDC/STC NOP-out, ARMv5 LDM-with-PC
                    interwork, QADD/QSUB/QDADD/QDSUB, SMUL*/SMLA*/SMULW*/SMLAW*/SMLAL*.
    thumb.ts        Full THUMB-1 dispatch with ARM9 v5 POP {PC} interwork.
    cpu.ts          Top-level step(). JS-side IRQ entry/return. Optional `recomp` hook
                    that dispatches into the JIT before each interpreter step.
    cp15.ts         ARM9 system control coprocessor. DTCM/ITCM base + virtual size + load
                    mode + enable bits. Re-patches the BIOS IRQ stub literal when DTCM moves.
    disasm.ts       Small ARM-mode disassembler for the UI hex panels.
    bus.ts          Shared ArmBus interface used by Bus9 / Bus7.
  recomp/
    compiler.ts     WASM basic-block Thumb JIT. Tracks hot PCs; compiles blocks of
                    Format 3/4/9/16/18 ops to WASM with the register file + CPSR in
                    shared linear memory. Bus I/O still goes through imported callbacks.
    wasm-emit.ts    Module-format byte writer + opcode emission helpers.
  memory/
    bus9.ts         ARM9 view: BIOS, ITCM + DTCM (with mirroring and load mode), Main RAM
                    at 0x02xxxxxx + 0x01xxxxxx mirror, shared WRAM via WRAMCNT, IO at
                    0x04xxxxxx, VRAM via VramRouter at 0x06xxxxxx, OAM, PRAM, high-vector
                    BIOS at 0xFFFF0000.
    bus7.ts         ARM7 view: BIOS, Main RAM, shared WRAM (complementary WRAMCNT view),
                    private IWRAM at 0x03800000, IO, ARM7-mode VRAM banks (C/D with MST=2),
                    WiFi MMIO at 0x04800000.
    shared.ts       Backing storage shared between both buses.
    regions.ts      Constants for region bases / sizes.
    vram_router.ts  Translates 0x06xxxxxx addresses to flat vram[] offsets across the
                    9 banks. Handles BG / OBJ / LCDC / sub-BG / sub-OBJ / BG ext-palette
                    / OBJ ext-palette / texture / texture-palette mappings per VRAMCNT_x.
  io/
    irq.ts          Per-CPU IE/IF/IME with cachedPending flag.
    io.ts           Byte/half/word IO router. DISPCNT A/B, DISPSTAT, VCOUNT, BGxCNT,
                    BGxHOFS/VOFS, affine BG PA/PB/PC/PD + reference X/Y for both engines,
                    VRAMCNT_A..I + VRAMSTAT + WRAMSTAT, KEYINPUT, EXTKEYIN, IE/IF/IME,
                    POSTFLG, HALTCNT, WRAMCNT, GXFIFO + direct-cmd region, sound
                    channel registers (ARM7), POWCNT1, blend / master brightness.
    ipc.ts          IPCSYNC (with bit-13 strobe + value-change IRQ) + two 16-entry
                    one-way FIFOs with send-empty / recv-not-empty IRQs. Built-in PXI
                    stub server replies to specific retail-game probes so SDK boot can
                    advance past ARM7 subsystem handshakes we don't model.
    dma.ts          4 channels per CPU. Immediate / VBlank / HBlank / cardready timing,
                    repeat mode, increment-reload, 16-bit + 32-bit transfers, IRQ on done.
    timers.ts       4 timers per CPU. Prescaler (1 / 64 / 256 / 1024), cascade / count-up
                    chain, IRQ on overflow, reload latched on enable rising edge.
    ds_math.ts      ARM9-only Div/Sqrt coprocessor.
    spi.ts          Firmware blob (touchscreen calibration + user settings), TSC2046
                    touchscreen with Z1/Z2 pressure channels, PM, mic.
    rtc.ts          DS RTC: date / time, alarm 1+2 persistence, clk-adjust, free-reg.
    sound.ts        16-channel mixer. PCM8 + PCM16 source decode, posFrac sample cursor,
                    L/R panning + volume, master gain, Web Audio bridge.
    wifi.ts         WiFi register stubs at 0x04800000+.
  ppu/
    ppu.ts          Scanline scheduler (263 lines × 355 dots), VBlank / HBlank IRQs,
                    framebuffers, master brightness composite.
    text_bg.ts      Per-scanline text-mode BG composer: 4 BGs in priority order,
                    4bpp / 8bpp / ext-palette pixel modes, 4 screen sizes, H/V flip.
    affine_bg.ts    Affine + extended-affine BG: tile-affine, palette bitmap, direct
                    color bitmap. PA/PB/PC/PD + reference X/Y.
    bitmap_bg.ts    Bitmap BG modes (direct color + palette).
    sprites.ts      OAM scanner, 1D / 2D mapping, regular + affine sprites, mosaic,
                    OBJ ext-palette, window OBJ.
    blend.ts        Color-effect compositor (alpha / brightness-up / brightness-down).
    window.ts       WIN0 / WIN1 / WINOBJ / WINOUT inside-window selectors.
    gx.ts           3D engine command stream: viewport, MTX_MODE / load / mult / push /
                    pop, BEGIN_VTXS / END_VTXS, VTX_16 / VTX_10 / VTX_DIFF / VTX_XY etc,
                    COLOR, polygon-attr, rasterizer into the 3D framebuffer.
    engine_a.ts     Dispatcher per DISPCNT display mode (forced blank, LCDC direct,
                    text mode 0-5, video FIFO).
  bios/
    hle.ts          SWI HLE: IntrWait, VBlankIntrWait, Halt, Divide, Sqrt, CpuSet,
                    CpuFastSet, BitUnPack, LZ77UnCompReadByCopy16, GetCRC16, etc.
    stub.ts         Installs a small ARM-mode dispatcher at each CPU's BIOS vector 0x18
                    as a fallback for IRQs taken before the JS HLE is attached.
  cart/
    header.ts       512-byte NDS header parser.
    banner.ts       Banner icon (32×32 4bpp) + multi-language title decode.
    loader.ts       Copies ARM9 + ARM7 binaries from ROM to their RAM destinations.
    overlays.ts     Walks the overlay descriptor table + FAT and preloads non-colliding
                    overlays into Main RAM.
    cart.ts         Cartridge command interface — ROMCTRL, ROMCMD, AUXSPI*, ROMDATA.
                    Handles cmd 0x9F (dummy), 0x00 (header), 0x90 (chip ID), 0xB7
                    (addressed read), per-game save-chip protocol (EEPROM 0.5K / 8K,
                    FLASH 1M) keyed off NDS game-code lookup table.
    nsmb_fs_assist.ts  NSMB-specific FS-thunk assist for filesystem reads that the
                    SDK normally services from cart-DMA we don't fully model.
  audio/
    audio_bridge.ts Web Audio AudioContext + ScriptProcessorNode that pulls from the
                    sound mixer once per output buffer.
  ui/
    App.tsx         Router + PlayerPage. Two-canvas DS layout, banner panel, live debug
                    sidebar (CPU/IRQ/PPU/IPC/JIT/sound/DMA), live disasm-at-PC panel,
                    virtual control pad, JIT toggle, snapshot download.
    LibraryPage.tsx Card grid grouped by tier.
    RomDetailPage.tsx Per-ROM known-issues page + ▶ Play button.
    EmuContext.tsx  React context that shares one Emulator across routes.
    romMeta.ts      Per-ROM metadata (path, label, tier, blurb, issues[]).
  emulator.ts       Composes everything. runFrame() interleaves ARM9 / ARM7 steps at
                    2:1 with a carry counter so they run paired at sub-instruction
                    granularity. Emulator.reset() wipes all volatile state to power-on
                    defaults — called from loadRom so switching ROMs doesn't leak the
                    previous game's main RAM / VRAM / IRQ / DMA / IPC / sound / WiFi
                    into the new one.
```

## Build + test

```bash
npm run test            # vitest run (469 tests)
npm run test:watch      # interactive
npm run test:coverage   # v8 coverage report
npm run lint            # oxlint
npm run build           # tsc && vite build → dist/
npm run dev             # vite dev server
```

## What's missing

The road from "9 retail ROMs render" to "every retail DS game boots" is long. Not implemented yet:

- **3D engine completeness**: per-vertex Gouraud lighting, fog, edge marking, anti-aliasing, texture mapping, polygon depth-test corner cases.
- **NitroSDK OS HLE**: `OS_CreateThread` / `OS_WakeupThread` modelling — NSMB and several others wait on thread-wake signals from threads we don't run.
- **SDK touch driver propagation**: cooked touch struct write to the OS shared-work area on VBlank — many state machines wait for it.
- **ADPCM decoder**: most retail sound is ADPCM; we emit silence for that format.
- **Cart on-demand overlay loading** via cart-DMA reads. Currently preloads at boot with collision-skipping.
- **Wi-Fi / DS Download Play / DSi-specific hardware**.
- **More save chips**: SRAM, FLASH 256K / 512K / 8M, EEPROM 64K.
- **Savestates**.
- **Microphone modelling** (needed for Brain Training voice exercises, Nintendogs naming, etc).

## Tech

- TypeScript everywhere with TypedArrays for hot paths
- WebAssembly for the optional Thumb JIT
- React 19 + Tailwind 4 + `react-router-dom` for UI
- Vite for the dev server + bundler
- Vitest for tests (+ v8 coverage)
- Oxlint for lint
- localStorage for ROM selection persistence

The core emulator (`cpu/`, `memory/`, `io/`, `ppu/`, `bios/`, `cart/`, `recomp/`, `audio/`) is pure TypeScript with no DOM dependency — reusable under any UI shell.

## Reference

[GBATEK](https://problemkaputt.de/gbatek.htm) is the canonical NDS hardware reference and the source for all register layouts, IO semantics, and bus routing in this project.
