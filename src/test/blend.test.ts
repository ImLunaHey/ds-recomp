import { describe, it, expect } from 'vitest';
import { Emulator } from '../emulator';

// Set up a single-BG render where every pixel is palette colour 1.
// Caller sets palette[0] (backdrop) and palette[1] (BG colour).
function setupSolidBg0(emu: Emulator): void {
  const vram = emu.mem.vram;

  // Tile 0: all-1 nibbles, 4bpp.
  for (let i = 0; i < 32; i++) vram[i] = 0x11;
  // Screen map (32×32) at screen base 0x800 — every entry tile 0 / pal bank 0.
  for (let i = 0; i < 32 * 32; i++) {
    const off = 0x800 + i * 2;
    vram[off] = 0; vram[off + 1] = 0;
  }
  emu.ppu.bgCntA[0] = (1 << 8);            // priority 0
  emu.ppu.dispcntA  = (1 << 16) | (1 << 8);
}

function setPaletteColor(emu: Emulator, idx: number, bgr555: number): void {
  emu.mem.pram[idx * 2]     = bgr555 & 0xFF;
  emu.mem.pram[idx * 2 + 1] = (bgr555 >>> 8) & 0xFF;
}

function pixelBgr555(fb: Uint8ClampedArray, x: number, y: number): number {
  const i = (y * 256 + x) * 4;
  const r = fb[i]     >> 3;
  const g = fb[i + 1] >> 3;
  const b = fb[i + 2] >> 3;
  return (b << 10) | (g << 5) | r;
}

describe('Blend: BLDCNT/BLDALPHA/BLDY register store', () => {
  it('writes round-trip', () => {
    const emu = new Emulator();
    emu.io9.write16(0x04000050, 0x12C1);
    emu.io9.write16(0x04000052, 0x0A0B);
    emu.io9.write16(0x04000054, 0x0010);
    expect(emu.ppu.bldCntA).toBe(0x12C1);
    expect(emu.ppu.bldAlphaA).toBe(0x0A0B);
    expect(emu.ppu.bldYA).toBe(0x0010);
    // Engine B too.
    emu.io9.write16(0x04001050, 0x00C1);
    expect(emu.ppu.bldCntB).toBe(0x00C1);
  });
});

describe('Blend mode 2: fade-to-white on BG0', () => {
  it('half-fade lifts colour midway to white', () => {
    const emu = new Emulator();
    setupSolidBg0(emu);
    setPaletteColor(emu, 0, 0x0000);          // backdrop black
    setPaletteColor(emu, 1, 0x0010);          // R=16 only

    // BLDCNT: mode 2 (fade-white) = bits 6-7 = 10, target A = BG0 (bit 0).
    emu.ppu.bldCntA   = (2 << 6) | 0x01;
    emu.ppu.bldYA     = 8;                    // half fade (8/16)

    emu.runFrame();

    // Per spec: r' = r + (31 - r) * 8/16 = 16 + (31-16)*8/16 = 16 + 7 = 23.
    // g' = 0 + 31*8/16 = 15. b' = same as g' = 15.
    const c = pixelBgr555(emu.ppu.fbA, 100, 100);
    expect(c & 0x1F).toBe(23);                // R
    expect((c >>> 5)  & 0x1F).toBe(15);       // G
    expect((c >>> 10) & 0x1F).toBe(15);       // B
  });
});

describe('Blend mode 3: fade-to-black on BG0', () => {
  it('half-fade halves the colour', () => {
    const emu = new Emulator();
    setupSolidBg0(emu);
    setPaletteColor(emu, 0, 0x0000);
    setPaletteColor(emu, 1, 0x4210);           // R=16, G=16, B=16 (mid grey)

    emu.ppu.bldCntA = (3 << 6) | 0x01;
    emu.ppu.bldYA   = 8;

    emu.runFrame();

    // Each channel: 16 - 16*8/16 = 16 - 8 = 8.
    const c = pixelBgr555(emu.ppu.fbA, 100, 100);
    expect(c & 0x1F).toBe(8);
    expect((c >>> 5)  & 0x1F).toBe(8);
    expect((c >>> 10) & 0x1F).toBe(8);
  });
});

describe('Blend mode 1: alpha blend BG0 over backdrop', () => {
  it('produces (A*EVA + B*EVB)/16 in each component', () => {
    const emu = new Emulator();
    setupSolidBg0(emu);
    // BG0 = red 16, backdrop = blue 16.
    setPaletteColor(emu, 0, 16 << 10);         // backdrop blue (B=16)
    setPaletteColor(emu, 1, 16);                // BG0 red

    // BLDCNT: mode 1 (alpha), target A = BG0, target B = backdrop (bit 5).
    emu.ppu.bldCntA   = (1 << 6) | (1 << 0) | (1 << 13);     // also bit 13 = BD target B
    emu.ppu.bldAlphaA = (4 << 8) | 8;          // EVA=8, EVB=4

    emu.runFrame();

    // R = (16*8 + 0*4)/16 = 8. G = 0. B = (0*8 + 16*4)/16 = 4.
    const c = pixelBgr555(emu.ppu.fbA, 100, 100);
    expect(c & 0x1F).toBe(8);
    expect((c >>> 5)  & 0x1F).toBe(0);
    expect((c >>> 10) & 0x1F).toBe(4);
  });
});

describe('Blend mode 0: no blend even when targets are set', () => {
  it('leaves BG0 pixel unmodified', () => {
    const emu = new Emulator();
    setupSolidBg0(emu);
    setPaletteColor(emu, 0, 0x7FFF);            // bright backdrop
    setPaletteColor(emu, 1, 16);                 // BG0 red R=16

    emu.ppu.bldCntA   = 0x01 | (1 << 13);       // mode 0, targets set
    emu.ppu.bldAlphaA = (16 << 8) | 16;          // not used in mode 0
    emu.ppu.bldYA     = 16;

    emu.runFrame();

    const c = pixelBgr555(emu.ppu.fbA, 100, 100);
    expect(c & 0x1F).toBe(16);
    expect((c >>> 5)  & 0x1F).toBe(0);
    expect((c >>> 10) & 0x1F).toBe(0);
  });
});
