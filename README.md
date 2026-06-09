# ds-recomp

A Nintendo DS emulator running entirely in the browser. ARM9 (ARMv5TE + CP15) and ARM7 (ARMv4T) interpreters written from scratch in TypeScript, two-bus memory map, IPC SYNC + FIFO, DMA, scanline-accurate 2D text-BG compositor, BIOS HLE for the common SWIs (IntrWait, VBlankIntrWait, Halt, Div, Sqrt, CpuSet, CpuFastSet), JS-side IRQ-take HLE that bypasses the in-BIOS ARM stub, DS Math coprocessor (Div + Sqrt), VRAM bank router honoring VRAMCNT_x mappings.

No prebuilt BIOS, no off-the-shelf cores — the whole stack is TypeScript with TypedArrays.

## Status

| ROM | Boots | IPC OK | Display | Notes |
|---|---|---|---|---|
| RockWrestler (NDS test ROM) | ✓ | ✓ | ✓ | Heartbeat green, menu draws via LCDC. |
| Pokemon Platinum | ✓ | ✓ | — | ARM9 reaches the SDK autoload area before going off the rails; needs autoload-list driven runtime to display content. |

22 vitest cases cover the DS Math coprocessor, ARMv5 saturation + DSP halfword multiplies, and the DTCM/ITCM virtual-size mirroring + load-mode semantics.

## Quick start

```bash
git clone git@github.com:ImLunaHey/ds-recomp.git
cd ds-recomp
npm install
npm run dev
```

Open the URL Vite prints. Put any `.nds` file in `public/`; the file picker in the UI lists the built-ins (Pokemon Platinum and RockWrestler) and you can drag-and-drop other ROMs onto the drop zone. `public/*.nds` is gitignored — ROMs are never shipped.

The currently selected ROM is persisted to `localStorage` and autoplay is on so frames start ticking immediately.

## Controls

| NDS button | Keyboard |
|---|---|
| A | Z |
| B | X |
| Start | Enter |
| Select | Shift |
| D-pad | Arrow keys |
| L / R | A / S |
| X / Y | Q / W |

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
    cpu.ts          Top-level step(). JS-side IRQ entry/return: pushes context to IRQ
                    stack, reads user handler ptr (DTCM_END-4 on ARM9, 0x03FFFFFC on ARM7),
                    sets LR to a magic marker; on next step() seeing the marker, restores
                    context via SPSR and resumes pre-IRQ code.
    cp15.ts         ARM9 system control coprocessor. DTCM/ITCM base + virtual size + load
                    mode + enable bits. Updates the BIOS IRQ stub literal when DTCM moves.
    disasm.ts       Small ARM-mode disassembler for the UI hex panels.
    bus.ts          Shared ArmBus interface used by Bus9 / Bus7.
  memory/
    bus9.ts         ARM9 view: BIOS, ITCM + DTCM (with mirroring and load mode), Main RAM
                    at 0x02xxxxxx + 0x01xxxxxx mirror, shared WRAM via WRAMCNT, IO at
                    0x04xxxxxx, VRAM via VramRouter at 0x06xxxxxx, OAM, PRAM, high-vector
                    BIOS at 0xFFFF0000.
    bus7.ts         ARM7 view: BIOS, Main RAM, shared WRAM (complementary WRAMCNT view),
                    private IWRAM at 0x03800000, IO, ARM7-mode VRAM banks (C/D with MST=2).
    shared.ts       Backing storage shared between both buses.
    regions.ts      Constants for region bases / sizes.
    vram_router.ts  Translates 0x06xxxxxx addresses to flat vram[] offsets, walking the
                    9 banks and respecting their VRAMCNT_x (enable / MST / OFFSET).
  io/
    irq.ts          Per-CPU IE/IF/IME with cachedPending flag.
    io.ts           Byte/half/word IO router. DISPCNT A/B, DISPSTAT, VCOUNT, BGxCNT,
                    BGxHOFS/VOFS for both engines, VRAMCNT_A..I (ARM9 write) /
                    VRAMSTAT + WRAMSTAT (ARM7 read), KEYINPUT, EXTKEYIN, IE/IF/IME,
                    POSTFLG, HALTCNT, WRAMCNT.
    ipc.ts          IPCSYNC (with bit-13 strobe + value-change IRQ) + two 16-entry
                    one-way FIFOs with send-empty / recv-not-empty IRQs.
    dma.ts          4 channels per CPU, immediate + VBlank timing.
    ds_math.ts      ARM9-only Div/Sqrt coprocessor. BigInt-backed 32/32, 64/32, 64/64
                    signed truncating division; floor-sqrt via Newton's method on BigInt.
  ppu/
    ppu.ts          Scanline scheduler (263 lines × 355 dots), VBlank IRQ, framebuffers.
    text_bg.ts      Per-scanline text-mode BG composer: 4 BGs in priority order,
                    4bpp / 8bpp pixel modes, 4 screen sizes, H/V flip per tile.
    engine_a.ts     Dispatcher per DISPCNT display mode (forced blank, LCDC direct, BG
                    mode 0). Rendered into Engine A / Engine B framebuffers.
  bios/
    hle.ts          SWI HLE: IntrWait, VBlankIntrWait, Halt, Divide, CpuSet, CpuFastSet,
                    Sqrt. IntrWait clears CPSR.I + sets IME = 1 before halting so the
                    IRQ the caller is waiting for can actually fire.
    stub.ts         Installs a small ARM-mode dispatcher at each CPU's BIOS vector 0x18
                    as a fallback for IRQs taken before the JS HLE is attached.
  cart/
    header.ts       512-byte NDS header parser.
    banner.ts       Banner icon (32×32 4bpp) + English title decode.
    loader.ts       Copies ARM9 + ARM7 binaries from ROM to their RAM destinations.
    overlays.ts     Walks the overlay descriptor table + FAT and preloads non-colliding
                    overlays into Main RAM.
    cart.ts         Cartridge command interface — ROMCTRL, ROMCMD, AUXSPI*, ROMDATA.
                    Handles cmd 0x9F (dummy), 0x00 (header), 0x90 (chip ID), 0xB7
                    (addressed read).
  ui/               React 19 + Tailwind 4 single-page UI. Two-canvas DS layout, live
                    stats panel, ROM picker with localStorage persistence + autoplay,
                    keyboard → KEYINPUT bridge, "Test Pattern" and "Render Banner"
                    demo buttons.
  emulator.ts       Composes everything. runFrame() interleaves ARM9 / ARM7 steps at
                    2:1 with a carry counter so they run paired at sub-instruction
                    granularity.
```

## Build + test

```bash
npm run test        # vitest run
npm run test:watch  # interactive
npm run lint        # oxlint
npm run build       # tsc && vite build → dist/
npm run dev         # vite dev server
```

## What's missing

The road from "RockWrestler menu rendering" to "every retail DS game boots" is long. Not implemented yet:

- **3D engine** (geometry + rasterizer + GXFIFO). Most retail games use the 3D engine for menus and overworld; without it Pokemon Platinum stays at a black screen even with everything else working.
- **SPI**: firmware blob (touchscreen calibration, sysclock, user data), touchscreen, RTC.
- **Sound**: 16-channel ARM7 mixer with PCM8/PCM16/ADPCM/PSG and capture.
- **Cart on-demand overlay loading** via cart-DMA reads. Currently preloads at boot.
- **More BIOS HLE**: HuffmanUnComp, RLUnComp, LZ77UnComp, ObjAffineSet, BitUnPack.
- **Affine BGs, bitmap BG modes, sprites, windows, blending** in Engine A.
- **Engine B** specific quirks.
- **Wi-Fi / DS Download Play** (probably never).
- **Savestates** + cart save chips (SRAM, Flash, EEPROM).

## Tech

- TypeScript everywhere with TypedArrays for hot paths
- React 19 + Tailwind 4 for UI
- Vite for the dev server + bundler
- Vitest for tests
- Oxlint for lint
- localStorage for ROM selection persistence

The core emulator (`cpu/`, `memory/`, `io/`, `ppu/`, `bios/`, `cart/`) is pure TypeScript with no DOM dependency — reusable under any UI shell.

## Reference

[GBATEK](https://problemkaputt.de/gbatek.htm) is the canonical NDS hardware reference and the source for all register layouts, IO semantics, and bus routing in this project.
