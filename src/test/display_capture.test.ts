import { describe, it, expect } from 'vitest';
import { Emulator } from '../emulator';

describe('DISPCAPCNT register store', () => {
  it('32-bit write round-trips', () => {
    const emu = new Emulator();
    emu.io9.write32(0x04000064, 0x82345678 >>> 0);
    expect(emu.ppu.dispCapCnt >>> 0).toBe(0x82345678 >>> 0);
    expect(emu.io9.read32(0x04000064) >>> 0).toBe(0x82345678 >>> 0);
  });
});

describe('Display capture: source A → VRAM', () => {
  it('captures engine A composited output into VRAM bank A and clears enable bit', () => {
    const emu = new Emulator();
    // Black backdrop, render full-screen blue from BG0.
    const pram = emu.mem.pram;
    const vram = emu.mem.vram;
    pram[0] = 0x00; pram[1] = 0x00;             // backdrop black
    pram[2] = 0x00; pram[3] = 0x7C;             // palette[1] = blue (0x7C00)
    // Tile 0 all-1 nibbles + screen map of tile 0 at screen base 0x800.
    for (let i = 0; i < 32; i++) vram[i] = 0x11;
    for (let i = 0; i < 32 * 32; i++) {
      const off = 0x800 + i * 2;
      vram[off] = 0; vram[off + 1] = 0;
    }
    emu.ppu.bgCntA[0] = (1 << 8);
    emu.ppu.dispcntA  = (1 << 16) | (1 << 8);

    // Set up capture: enable | size=3 (256x192) | bank=0 (A) | source A | EVA=16
    emu.ppu.dispCapCnt = (1 << 31) | (3 << 20) | (0 << 16) | (0 << 29) | 16;

    emu.runFrame();

    // Bank A starts at byte 0 of VRAM. Each captured pixel is 16-bit
    // BGR555. Read the centre pixel; it should be blue (~0x7C00).
    const off = (100 * 256 + 100) * 2;
    const captured = vram[off] | (vram[off + 1] << 8);
    expect(captured & 0x7FFF).toBe(0x7C00);

    // Enable bit cleared.
    expect((emu.ppu.dispCapCnt >>> 31) & 1).toBe(0);
  });

  it('does nothing when enable bit is clear', () => {
    const emu = new Emulator();
    // Pre-populate VRAM bank A with sentinel bytes.
    const vram = emu.mem.vram;
    for (let i = 0; i < 0x20000; i++) vram[i] = 0xAA;

    emu.ppu.dispcntA = (1 << 16);
    emu.ppu.dispCapCnt = 0;            // not enabled

    emu.runFrame();

    expect(vram[0]).toBe(0xAA);
    expect(vram[1]).toBe(0xAA);
  });

  it('honours size selection — only writes captureH lines', () => {
    const emu = new Emulator();
    const vram = emu.mem.vram;
    // Sentinel-fill bank A.
    for (let i = 0; i < 0x20000; i++) vram[i] = 0xAA;

    // Backdrop = black so source A is all-zero BGR555. We rely on the
    // "drawn" alpha bit being on so colour stored is 0x8000.
    emu.mem.pram[0] = 0x00; emu.mem.pram[1] = 0x00;
    emu.ppu.dispcntA = (1 << 16);

    // size=1 → 256x64. Bank=A, source=A.
    emu.ppu.dispCapCnt = (1 << 31) | (1 << 20) | 16;

    emu.runFrame();

    // First 64 lines * 256 px * 2 bytes = 0x8000 bytes were touched.
    // Captured pixel = 0x8000 (alpha bit on, RGB=0) → low byte 0, high 0x80.
    expect(vram[0]).toBe(0x00);
    expect(vram[1]).toBe(0x80);
    // Past line 64, the sentinel should still be there at line 100 col 0:
    // dst = (100 * 256 + 0) * 2 = 51200 bytes from bank-A base = 0xC800.
    // Bank A spans 0..0x1FFFF so 0xC800 is in-bank but past captured area.
    expect(vram[0xC800]).toBe(0xAA);
    expect(vram[0xC801]).toBe(0xAA);
  });
});
