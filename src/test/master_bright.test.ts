import { describe, it, expect } from 'vitest';
import { Emulator } from '../emulator';

function pixelRgb(fb: Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const i = (y * 256 + x) * 4;
  return [fb[i], fb[i + 1], fb[i + 2]];
}

describe('MASTER_BRIGHT register store', () => {
  it('byte writes assemble into 16-bit reg', () => {
    const emu = new Emulator();
    emu.io9.write16(0x0400006C, 0x4008);          // mode 1, factor 8
    expect(emu.ppu.masterBrightA).toBe(0x4008);
    emu.io9.write16(0x0400106C, 0x800F);          // mode 2, factor 15
    expect(emu.ppu.masterBrightB).toBe(0x800F);
    expect(emu.io9.read16(0x0400006C)).toBe(0x4008);
    expect(emu.io9.read16(0x0400106C)).toBe(0x800F);
  });
});

describe('MASTER_BRIGHT mode 1: fade-to-white', () => {
  it('half fade (factor 8) lifts every pixel midway toward 255', () => {
    const emu = new Emulator();
    // Engine A: forced blank, so the compositor fills every pixel with 0xFF.
    // To get a mid-grey baseline let's instead use LCDC display mode 2
    // pointing at bank A — but easier: just set DISPCNT mode 1 with the
    // backdrop palette[0] = mid grey 0x4210.
    emu.mem.pram[0] = 0x10; emu.mem.pram[1] = 0x42;       // backdrop BGR555 = (16,16,16)
    emu.ppu.dispcntA = (1 << 16);                           // graphics mode, BG0/etc. disabled

    emu.ppu.masterBrightA = 0x4008;                         // mode 1, factor 8

    emu.runFrame();

    // Backdrop = 16 * 8 = 128. After fade-to-white with factor 8:
    //   px' = px + (255 - px) * 8 / 16 = 128 + (255-128)*8/16 = 128 + 63 = 191.
    const [r, g, b] = pixelRgb(emu.ppu.fbA, 100, 100);
    expect(r).toBe(191);
    expect(g).toBe(191);
    expect(b).toBe(191);
  });

  it('full fade (factor 16) saturates to white', () => {
    const emu = new Emulator();
    emu.mem.pram[0] = 0x00; emu.mem.pram[1] = 0x00;       // black backdrop
    emu.ppu.dispcntA = (1 << 16);
    emu.ppu.masterBrightA = 0x4010;                         // mode 1, factor 16

    emu.runFrame();

    const [r, g, b] = pixelRgb(emu.ppu.fbA, 80, 80);
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBe(255);
  });
});

describe('MASTER_BRIGHT mode 2: fade-to-black', () => {
  it('half fade dims pixel toward black', () => {
    const emu = new Emulator();
    emu.mem.pram[0] = 0xFF; emu.mem.pram[1] = 0x7F;       // white backdrop
    emu.ppu.dispcntA = (1 << 16);
    emu.ppu.masterBrightA = 0x8008;                         // mode 2, factor 8

    emu.runFrame();

    // White is 31*8 = 248. After fade: 248 - 248*8/16 = 248 - 124 = 124.
    const [r, g, b] = pixelRgb(emu.ppu.fbA, 50, 50);
    expect(r).toBe(124);
    expect(g).toBe(124);
    expect(b).toBe(124);
  });
});

describe('MASTER_BRIGHT mode 0: disabled (pass-through)', () => {
  it('leaves framebuffer untouched even with factor 16', () => {
    const emu = new Emulator();
    emu.mem.pram[0] = 0x10; emu.mem.pram[1] = 0x42;
    emu.ppu.dispcntA = (1 << 16);
    emu.ppu.masterBrightA = 0x0010;                         // mode 0, factor 16

    emu.runFrame();

    const [r, g, b] = pixelRgb(emu.ppu.fbA, 50, 50);
    expect(r).toBe(128);
    expect(g).toBe(128);
    expect(b).toBe(128);
  });
});

describe('MASTER_BRIGHT engine B applies independently', () => {
  it('engine A unchanged when only engine B is faded', () => {
    const emu = new Emulator();
    emu.mem.pram[0] = 0x10; emu.mem.pram[1] = 0x42;          // engine A backdrop
    emu.mem.pram[0x400] = 0x10; emu.mem.pram[0x401] = 0x42;   // engine B backdrop
    emu.ppu.dispcntA = (1 << 16);
    emu.ppu.dispcntB = (1 << 16);

    emu.ppu.masterBrightB = 0x8010;                            // mode 2 full

    emu.runFrame();

    const [rA] = pixelRgb(emu.ppu.fbA, 50, 50);
    expect(rA).toBe(128);
    const [rB] = pixelRgb(emu.ppu.fbB, 50, 50);
    expect(rB).toBe(0);
  });
});
