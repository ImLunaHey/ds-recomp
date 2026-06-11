// Coverage for the ARM9 DMA GXFIFO timing (=7) handler added in
// src/io/dma.ts. NitroSDK games stream their geometry-engine command
// list into 0x04000400 (GXFIFO) via a DMA channel programmed with
// timing=7. Real hardware fires the channel whenever the GX FIFO drops
// below half-full; our GX implementation drains every write
// synchronously, so the FIFO is permanently "below half-full" and the
// SDK driver expects the DMA to fire immediately on arm + once per
// frame thereafter for repeat-mode reloads.
//
// Without this, Nintendogs - Labrador locks at the post-Nintendo-logo
// fade-out with MASTER_BRIGHT_A = 0x4010 because the SDK GX-DMA
// helper sets a flag at 0x02155b64 before arming the channel and
// busy-waits for the DMA3 completion IRQ handler to clear it — the
// channel never runs, the IRQ never fires, the flag stays at 1, and
// the fade-in (which would have cleared MASTER_BRIGHT back to 0)
// never reaches the SDK's frame-prep stage.

import { describe, it, expect } from 'vitest';
import { Emulator } from '../emulator';

// Build a DMA3 register write that arms the channel with the given
// timing and irq-on-done bits, using the standard NDS DMACNT layout:
// bits 0..20 = word count, 21..27 = control fields, 28..30 = mode/timing/IRQ, 31 = enable.
// For our purposes: word32 = 1, srcMode = incr, dstMode = fixed (GXFIFO
// is a single MMIO word), timing in bits 11..13, irqOnDone in bit 14,
// enable in bit 15 of the high half.
function makeDmacnt(opts: {
  count: number;
  timing: number;
  irqOnDone: boolean;
  word32?: boolean;
  dstMode?: number;
}): number {
  const word32 = opts.word32 ?? true;
  const dstMode = opts.dstMode ?? 2;       // fixed
  const ctrl =
    (dstMode << 5) |
    (0     << 7) |                          // srcMode = incr
    (0     << 9) |                          // repeat = 0
    ((word32 ? 1 : 0) << 10) |
    ((opts.timing & 0x7) << 11) |
    ((opts.irqOnDone ? 1 : 0) << 14) |
    (1     << 15);                          // enable
  return ((ctrl & 0xFFFF) << 16) | (opts.count & 0xFFFF);
}

describe('ARM9 DMA timing=7 (GXFIFO)', () => {
  it('fires the channel synchronously when enabled (no VBlank needed)', () => {
    // Stage a 4-word buffer in main RAM at 0x02000800 and have DMA3
    // pump it into the GXFIFO. The PPU GX implementation accepts any
    // 32-bit word and drains it, so the buffer's exact contents don't
    // matter — we just need the writes to land.
    const emu = new Emulator();
    // Need to initialize CPUs / loader minimally; use a dummy ROM.
    // Construct a 1 MB ROM with zero headers; only the loader's
    // entry-point setup matters for these IO-only tests.
    const rom = new Uint8Array(0x100000);
    // Stamp a minimal-but-valid NDS header so parseNdsHeader doesn't
    // throw — ARM9 entry/load points just have to lie in main RAM.
    const tdEnc = new TextEncoder();
    rom.set(tdEnc.encode('TEST DMA TIMING7'), 0x000);
    rom.set(tdEnc.encode('TEST'), 0x00C);                          // gameCode
    const writeU32 = (off: number, v: number) => {
      rom[off]     =  v        & 0xFF;
      rom[off + 1] = (v >>  8) & 0xFF;
      rom[off + 2] = (v >> 16) & 0xFF;
      rom[off + 3] = (v >> 24) & 0xFF;
    };
    writeU32(0x020, 0x4000);            // arm9 rom offset
    writeU32(0x024, 0x02000800);        // arm9 entry
    writeU32(0x028, 0x02000800);        // arm9 ram
    writeU32(0x02C, 0x100);             // arm9 size
    writeU32(0x030, 0x4100);            // arm7 rom offset
    writeU32(0x034, 0x02380000);        // arm7 entry
    writeU32(0x038, 0x02380000);        // arm7 ram
    writeU32(0x03C, 0x100);             // arm7 size
    emu.loadRom(rom);

    // Pre-load 4 words into main RAM (the bytes we want streamed to GXFIFO).
    const ram = emu.mem.mainRam;
    for (let i = 0; i < 16; i++) ram[0x800 + i] = (i + 1) & 0xFF;

    // Program DMA3.
    // DMA3SAD = 0x040000D4, DMA3DAD = 0x040000D8, DMA3CNT = 0x040000DC
    emu.io9.write32(0x040000D4, 0x02000800);     // src
    emu.io9.write32(0x040000D8, 0x04000400);     // dst (GXFIFO)

    // Pre-check: GX FIFO consumed nothing yet — pendingOps is empty.
    expect(emu.ppu.gx.pendingOps.length).toBe(0);

    // Arm the channel with timing=7. Our fix should run the transfer
    // immediately. We don't fire a VBlank, don't step the CPU, and
    // don't write to GXFIFO any other way.
    emu.io9.write32(0x040000DC, makeDmacnt({
      count: 4,
      timing: 7,
      irqOnDone: false,
    }));

    // Channel must have run — channel is single-shot (not repeating)
    // so enabled should be back to false.
    expect(emu.dma9.channels[3].enabled).toBe(false);
    // The first word of our source data was 0x04030201 (bytes
    // 0x01,0x02,0x03,0x04 LE). GX FIFO parses bytes 1,2,3,4 as opcodes
    // — opcode 0x01 is unimplemented in our GX (silently consumed)
    // but the FIFO state moves forward. Just check that the source
    // pointer was advanced 16 bytes (4 words × 4 bytes).
    expect(emu.dma9.channels[3].src).toBe((0x02000800 + 16) >>> 0);
  });

  it('raises IRQ_DMA3 (bit 11 of IF) when irqOnDone is set', () => {
    const emu = new Emulator();
    const rom = new Uint8Array(0x100000);
    new TextEncoder().encodeInto('TEST DMA IRQ    ', rom.subarray(0));
    new TextEncoder().encodeInto('TEST', rom.subarray(0x0C, 0x10));
    // Minimal header so loader doesn't throw.
    const writeU32 = (off: number, v: number) => {
      rom[off]     =  v        & 0xFF;
      rom[off + 1] = (v >>  8) & 0xFF;
      rom[off + 2] = (v >> 16) & 0xFF;
      rom[off + 3] = (v >> 24) & 0xFF;
    };
    writeU32(0x020, 0x4000);
    writeU32(0x024, 0x02000800);
    writeU32(0x028, 0x02000800);
    writeU32(0x02C, 0x100);
    writeU32(0x030, 0x4100);
    writeU32(0x034, 0x02380000);
    writeU32(0x038, 0x02380000);
    writeU32(0x03C, 0x100);
    emu.loadRom(rom);

    emu.io9.write32(0x040000D4, 0x02000800);
    emu.io9.write32(0x040000D8, 0x04000400);
    // Clear IF before arm so we can see the IRQ flip.
    emu.irq9.if_ = 0;
    emu.io9.write32(0x040000DC, makeDmacnt({
      count: 1,
      timing: 7,
      irqOnDone: true,
    }));

    // IRQ_DMA3 = 1 << 11. The fix runs the channel synchronously, and
    // runChannel raises that bit when irqOnDone.
    expect(emu.irq9.if_ & (1 << 11)).toBe(1 << 11);
  });

  it('stays quiet on ARM7: DMA timing field is only 2 bits there', () => {
    // ARM7 only has 4 DMA timings (immediate / VBlank / HBlank / DSP-Sound),
    // encoded in bits 12..13 of DMACNT. There is no GXFIFO on ARM7. Our
    // fix is gated on isArm9 — verify a fictional timing=7 write to
    // ARM7 does NOT trigger the GXFIFO path (it would parse as timing=3,
    // which is sound, also not implemented but specifically NOT GXFIFO).
    const emu = new Emulator();
    const rom = new Uint8Array(0x100000);
    new TextEncoder().encodeInto('TEST DMA ARM7   ', rom.subarray(0));
    new TextEncoder().encodeInto('TEST', rom.subarray(0x0C, 0x10));
    const writeU32 = (off: number, v: number) => {
      rom[off]     =  v        & 0xFF;
      rom[off + 1] = (v >>  8) & 0xFF;
      rom[off + 2] = (v >> 16) & 0xFF;
      rom[off + 3] = (v >> 24) & 0xFF;
    };
    writeU32(0x020, 0x4000);  writeU32(0x024, 0x02000800);
    writeU32(0x028, 0x02000800); writeU32(0x02C, 0x100);
    writeU32(0x030, 0x4100);  writeU32(0x034, 0x02380000);
    writeU32(0x038, 0x02380000); writeU32(0x03C, 0x100);
    emu.loadRom(rom);

    emu.io7.write32(0x040000D4, 0x02380000);
    emu.io7.write32(0x040000D8, 0x04000400);   // ARM7-side this is sound, but we just need *some* dst
    // ARM7 DMACNT: timing 7 in bits 11..13 would only be read as 2 bits
    // (12..13), so timing=3 in our encoding.
    emu.io7.write32(0x040000DC, makeDmacnt({
      count: 1,
      timing: 7,
      irqOnDone: false,
    }));
    // ARM7 channel sees timing=3 (sound DMA, not GXFIFO) and our DMA
    // doesn't fire timing=3. So channel stays enabled — no synchronous
    // run.
    expect(emu.dma7.channels[3].enabled).toBe(true);
    expect(emu.dma7.channels[3].timing).toBe(3);
  });

  it('triggerVBlank() also re-fires armed GXFIFO channels (repeat-mode safety net)', () => {
    // For non-repeat (single-shot) channels the on-enable fire is
    // enough — repeat channels stay enabled across runs and the
    // VBlank re-trigger keeps them moving. Exercise the VBlank path
    // explicitly by manually re-arming after the initial fire.
    const emu = new Emulator();
    const rom = new Uint8Array(0x100000);
    new TextEncoder().encodeInto('TEST GX VBLANK  ', rom.subarray(0));
    new TextEncoder().encodeInto('TEST', rom.subarray(0x0C, 0x10));
    const writeU32 = (off: number, v: number) => {
      rom[off]     =  v        & 0xFF;
      rom[off + 1] = (v >>  8) & 0xFF;
      rom[off + 2] = (v >> 16) & 0xFF;
      rom[off + 3] = (v >> 24) & 0xFF;
    };
    writeU32(0x020, 0x4000);  writeU32(0x024, 0x02000800);
    writeU32(0x028, 0x02000800); writeU32(0x02C, 0x100);
    writeU32(0x030, 0x4100);  writeU32(0x034, 0x02380000);
    writeU32(0x038, 0x02380000); writeU32(0x03C, 0x100);
    emu.loadRom(rom);

    // Manually set up a DMA3 channel with timing=7 directly — bypass
    // applyCount's on-enable fire so the VBlank path is the ONLY thing
    // that can run it. (We can't easily plumb a "repeat=true" channel
    // through the public writeRomCtrl path without a real game's
    // setup, so just poke the channel struct directly.)
    const ch = emu.dma9.channels[3];
    ch.src = 0x02000800;
    ch.dst = 0x04000400;
    ch.srcLatched = 0x02000800;
    ch.dstLatched = 0x04000400;
    ch.countLatched = 1;
    ch.enabled = true;
    ch.timing = 7;
    ch.word32 = true;
    ch.dstMode = 2;
    ch.srcMode = 0;
    ch.irqOnDone = false;
    ch.repeat = true;

    const srcBefore = ch.src;
    emu.dma9.triggerVBlank();
    // Channel ran — src advanced by 4 bytes.
    expect(ch.src).toBe((srcBefore + 4) >>> 0);
    // Repeat=true keeps enable on.
    expect(ch.enabled).toBe(true);
  });
});
