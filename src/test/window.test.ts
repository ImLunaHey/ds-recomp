import { describe, it, expect } from 'vitest';
import { Emulator } from '../emulator';

// Set up engine A with a single 4bpp tile that fills the whole screen
// with palette colour 1. Returns the emulator with all the state ready
// for rendering — runFrame() will composite engine A.
function setupSolidBg0(emu: Emulator, bgColorBgr555: number, backdropBgr555: number): void {
  const pram = emu.mem.pram;
  const vram = emu.mem.vram;

  // Palette[0] = backdrop, palette[1] = bg colour.
  pram[0] = backdropBgr555 & 0xFF;        pram[1] = (backdropBgr555 >>> 8) & 0xFF;
  pram[2] = bgColorBgr555 & 0xFF;          pram[3] = (bgColorBgr555 >>> 8) & 0xFF;

  // Tile 0 at char base 0: 32 bytes (4bpp), every nibble = 1.
  for (let i = 0; i < 32; i++) vram[i] = 0x11;

  // Screen map: 32×32 entries of 2 bytes each, all pointing at tile 0
  // with palette bank 0. Place at screen base 0x800 (chosen via BG0CNT
  // screen base = 1).
  for (let i = 0; i < 32 * 32; i++) {
    const off = 0x800 + i * 2;
    vram[off] = 0; vram[off + 1] = 0;
  }

  emu.ppu.bgCntA[0] = (1 << 8);            // priority 0, char base 0, screen base 1
  emu.ppu.bgHofsA[0] = 0;
  emu.ppu.bgVofsA[0] = 0;

  // DISPCNT: graphics mode 1 (LCDC=1), mode 0 (text BGs), BG0 enabled.
  emu.ppu.dispcntA = (1 << 16) | (1 << 8);
}

function readPixel(fb: Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const i = (y * 256 + x) * 4;
  return [fb[i], fb[i + 1], fb[i + 2]];
}

describe('Window: WIN0 region gates BG0', () => {
  it('pixels inside WIN0 draw BG0, outside falls to backdrop', () => {
    const emu = new Emulator();
    // BG = bright red (0x001F), backdrop = bright blue (0x7C00).
    setupSolidBg0(emu, 0x001F, 0x7C00);

    // Enable WIN0 via DISPCNT bit 13.
    emu.ppu.dispcntA |= (1 << 13);

    // WIN0 = rectangle x:[64,128), y:[32,96).
    emu.ppu.winHA[0] = (64 << 8) | 128;       // left=64, right=128
    emu.ppu.winVA[0] = (32 << 8) | 96;        // top=32, bottom=96
    // WININ low 6 bits: BG0 visible inside WIN0, nothing else; OUT: nothing.
    emu.ppu.winInA  = 0x01;       // BG0 enabled inside WIN0
    emu.ppu.winOutA = 0x00;       // nothing enabled outside

    emu.runFrame();

    // Inside WIN0 → red.
    const inside = readPixel(emu.ppu.fbA, 80, 50);
    expect(inside[0]).toBeGreaterThan(200);     // R
    expect(inside[2]).toBeLessThan(32);         // B

    // Outside WIN0 → backdrop blue.
    const outside = readPixel(emu.ppu.fbA, 10, 10);
    expect(outside[0]).toBeLessThan(32);
    expect(outside[2]).toBeGreaterThan(200);

    // Just outside the right edge.
    const justOutsideRight = readPixel(emu.ppu.fbA, 128, 50);
    expect(justOutsideRight[2]).toBeGreaterThan(200);

    // Just inside the right edge.
    const justInsideRight = readPixel(emu.ppu.fbA, 127, 50);
    expect(justInsideRight[0]).toBeGreaterThan(200);
  });
});

describe('Window: WIN1 inside WIN0 priority', () => {
  it('WIN0 covers WIN1 when overlapping (WIN0 has higher priority)', () => {
    const emu = new Emulator();
    // Palette: [0]=black backdrop, [1]=red, [2]=green.
    const pram = emu.mem.pram;
    pram[0] = 0x00; pram[1] = 0x00;          // black
    pram[2] = 0x1F; pram[3] = 0x00;          // red
    pram[4] = 0xE0; pram[5] = 0x03;          // green (0x03E0)
    // Reuse the helper to set up palette[0/1] then override [2].
    setupSolidBg0(emu, 0x001F, 0x0000);
    pram[4] = 0xE0; pram[5] = 0x03;

    // Enable both windows.
    emu.ppu.dispcntA |= (1 << 13) | (1 << 14);

    // WIN0 covers x:[0,128), WIN1 covers x:[64,192). They overlap at [64,128).
    emu.ppu.winHA[0] = (0   << 8) | 128;
    emu.ppu.winVA[0] = (0   << 8) | 192;
    emu.ppu.winHA[1] = (64  << 8) | 192;
    emu.ppu.winVA[1] = (0   << 8) | 192;
    // WININ: WIN0 mask = BG0 visible, WIN1 mask = OBJ visible only
    // (BG0 NOT visible). So in the overlap, WIN0 wins and shows BG0.
    emu.ppu.winInA  = (0x10 << 8) | 0x01;      // WIN1 OBJ-only, WIN0 BG0-only
    emu.ppu.winOutA = 0x00;

    emu.runFrame();

    // In WIN0-only region (x=10): BG0 visible → red.
    const a = readPixel(emu.ppu.fbA, 10, 50);
    expect(a[0]).toBeGreaterThan(200);
    // In overlap (x=100, both windows cover it): WIN0 has priority → BG0 visible → red.
    const b = readPixel(emu.ppu.fbA, 100, 50);
    expect(b[0]).toBeGreaterThan(200);
    // In WIN1-only region (x=170): BG0 NOT visible → backdrop (black).
    const c = readPixel(emu.ppu.fbA, 170, 50);
    expect(c[0]).toBeLessThan(32);
    expect(c[1]).toBeLessThan(32);
    expect(c[2]).toBeLessThan(32);
  });
});

describe('Window: register byte addressing round-trip', () => {
  it('writes to WIN0H/V/IN/OUT survive read-back', () => {
    const emu = new Emulator();
    emu.io9.write16(0x04000040, 0x1234);   // WIN0H
    emu.io9.write16(0x04000042, 0x5678);   // WIN1H
    emu.io9.write16(0x04000044, 0x9ABC);   // WIN0V
    emu.io9.write16(0x04000046, 0xDEF0);   // WIN1V
    emu.io9.write16(0x04000048, 0xCAFE);   // WININ
    emu.io9.write16(0x0400004A, 0xBABE);   // WINOUT
    expect(emu.ppu.winHA[0]).toBe(0x1234);
    expect(emu.ppu.winHA[1]).toBe(0x5678);
    expect(emu.ppu.winVA[0]).toBe(0x9ABC);
    expect(emu.ppu.winVA[1]).toBe(0xDEF0);
    expect(emu.ppu.winInA).toBe(0xCAFE);
    expect(emu.ppu.winOutA).toBe(0xBABE);
    expect(emu.io9.read16(0x04000048)).toBe(0xCAFE);
    expect(emu.io9.read16(0x0400004A)).toBe(0xBABE);
  });
});
