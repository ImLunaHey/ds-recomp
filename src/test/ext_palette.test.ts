import { describe, it, expect, beforeEach } from 'vitest';
import { SharedMemory } from '../memory/shared';
import { VramRouter, setActiveVramRouter } from '../memory/vram_router';
import { renderTextScanline, type BgRegs } from '../ppu/text_bg';
import { renderObjScanline, newObjLine } from '../ppu/sprites';

// Per-bank physical offsets inside shared.vram[].
const BANK_E_OFF = 0x80000;
const BANK_F_OFF = 0x90000;
const BANK_G_OFF = 0x94000;
const BANK_H_OFF = 0x98000;
const BANK_I_OFF = 0xA0000;

// Engine A BG VRAM window starts at flat-vram offset 0; sprite VRAM at
// 0x20000 — these match the constants engine_a.ts uses.
const ENGINE_A_BG_VRAM_BASE = 0;
const ENGINE_A_OBJ_VRAM_BASE = 0x20000;

function freshMem(): SharedMemory {
  return new SharedMemory();
}

function installRouter(): VramRouter {
  const r = new VramRouter(new Uint8Array(9));
  setActiveVramRouter(r);
  // The router's vramcnt array is now what we'll mutate to install
  // banks for each test.
  return r;
}

describe('VramRouter: BG ext palette routing', () => {
  it('bank F MST=4 OFFSET=0 → BG slot 0 (Engine A)', () => {
    const r = new VramRouter(new Uint8Array(9));
    r.vramcnt[5] = 0x84;                          // F: enable, MST=4, OFFSET=0
    expect(r.resolveBgExtPalA(0, 0)).toBe(BANK_F_OFF);
    expect(r.resolveBgExtPalA(0, 0x1FFF)).toBe(BANK_F_OFF + 0x1FFF);
    expect(r.resolveBgExtPalA(1, 0)).toBe(-1);    // F at OFFSET=0 only covers slot 0
  });

  it('bank F MST=4 OFFSET=2 → BG slot 1 (Engine A)', () => {
    const r = new VramRouter(new Uint8Array(9));
    r.vramcnt[5] = 0x84 | (2 << 3);               // OFFSET = 2 → pair (0,1) + within=1 = slot 1
    expect(r.resolveBgExtPalA(1, 0)).toBe(BANK_F_OFF);
    expect(r.resolveBgExtPalA(0, 0)).toBe(-1);
  });

  it('bank G MST=4 OFFSET=1 → BG slot 2 (Engine A)', () => {
    const r = new VramRouter(new Uint8Array(9));
    r.vramcnt[6] = 0x84 | (1 << 3);               // OFFSET = 1 → pair (2,3) + within=0 = slot 2
    expect(r.resolveBgExtPalA(2, 0)).toBe(BANK_G_OFF);
    expect(r.resolveBgExtPalA(3, 0)).toBe(-1);
  });

  it('bank E MST=4 covers all four BG slots (Engine A)', () => {
    const r = new VramRouter(new Uint8Array(9));
    r.vramcnt[4] = 0x84;                          // E enable, MST=4
    expect(r.resolveBgExtPalA(0, 0)).toBe(BANK_E_OFF);
    expect(r.resolveBgExtPalA(1, 0)).toBe(BANK_E_OFF + 0x2000);
    expect(r.resolveBgExtPalA(2, 0)).toBe(BANK_E_OFF + 0x4000);
    expect(r.resolveBgExtPalA(3, 0x1234)).toBe(BANK_E_OFF + 0x6000 + 0x1234);
  });

  it('bank H MST=2 covers all four BG slots (Engine B)', () => {
    const r = new VramRouter(new Uint8Array(9));
    r.vramcnt[7] = 0x82;                          // H enable, MST=2
    expect(r.resolveBgExtPalB(0, 0)).toBe(BANK_H_OFF);
    expect(r.resolveBgExtPalB(3, 0x100)).toBe(BANK_H_OFF + 0x6000 + 0x100);
  });

  it('no bank mapped → resolution returns -1', () => {
    const r = new VramRouter(new Uint8Array(9));
    expect(r.resolveBgExtPalA(0, 0)).toBe(-1);
    expect(r.resolveBgExtPalB(0, 0)).toBe(-1);
  });
});

describe('VramRouter: OBJ ext palette routing', () => {
  it('bank F MST=5 → Engine A OBJ ext palette', () => {
    const r = new VramRouter(new Uint8Array(9));
    r.vramcnt[5] = 0x85;
    expect(r.resolveObjExtPalA(0)).toBe(BANK_F_OFF);
    expect(r.resolveObjExtPalA(0x1FFE)).toBe(BANK_F_OFF + 0x1FFE);
  });

  it('bank G MST=5 → Engine A OBJ ext palette (when F not mapped)', () => {
    const r = new VramRouter(new Uint8Array(9));
    r.vramcnt[6] = 0x85;
    expect(r.resolveObjExtPalA(0)).toBe(BANK_G_OFF);
  });

  it('bank I MST=3 → Engine B OBJ ext palette', () => {
    const r = new VramRouter(new Uint8Array(9));
    r.vramcnt[8] = 0x83;
    expect(r.resolveObjExtPalB(0)).toBe(BANK_I_OFF);
    expect(r.resolveObjExtPalB(0x1000)).toBe(BANK_I_OFF + 0x1000);
  });

  it('no bank mapped → -1', () => {
    const r = new VramRouter(new Uint8Array(9));
    expect(r.resolveObjExtPalA(0)).toBe(-1);
    expect(r.resolveObjExtPalB(0)).toBe(-1);
  });
});

describe('Text BG: ext palette rendering', () => {
  let mem: SharedMemory;
  let router: VramRouter;

  // A simple BG0 layout: char base 0, screen base 0, BGCNT bit 7 (8bpp).
  // A single tile at screen entry 0 with tileNum=0 and palBank chosen
  // by the test. The tile's first byte is the color index for pixel (0,0).
  function setup8bppBg(palBank: number, colorIdx: number): {
    regs: BgRegs;
    dispcnt: number;
  } {
    // Screen entry @ vram[0]: tileNum=0, palBank in bits 12-15.
    mem.vram[0] = 0;
    mem.vram[1] = (palBank << 4) & 0xF0;            // bits 12-15 of the 16-bit entry
    // Tile 0 data starts at vram[0 + charBase]. We'll place charBase
    // at 0x4000 (BGCNT charBase=1, 0x4000-byte unit).
    mem.vram[0x4000] = colorIdx;
    const cnt = new Uint16Array(4);
    cnt[0] = 0x80 | (1 << 2);                       // 8bpp, charBase index 1
    const regs: BgRegs = {
      cnt,
      hofs: new Uint16Array(4),
      vofs: new Uint16Array(4),
    };
    // Engine A graphics mode 1, BG0 enabled.
    const dispcnt = (1 << 16) | (1 << 8);
    return { regs, dispcnt };
  }

  beforeEach(() => {
    mem = freshMem();
    router = installRouter();
  });

  it('uses base PRAM when DISPCNT bit 30 is clear (fallback)', () => {
    const { regs, dispcnt } = setup8bppBg(/*palBank*/ 3, /*colorIdx*/ 5);
    // Base PRAM @ index 5 (= 5 × 2 = byte offset 10).
    mem.pram[10] = 0x1F;                            // BGR555 lo = pure red
    mem.pram[11] = 0x00;
    const out = new Uint8ClampedArray(256 * 4);
    renderTextScanline(mem, regs, 0, dispcnt, 0, ENGINE_A_BG_VRAM_BASE, out, 0, true);
    expect(out[0]).toBeGreaterThan(200);            // R ≈ 0xF8
    expect(out[1]).toBeLessThan(16);
    expect(out[2]).toBeLessThan(16);
    // Sanity: router reference exists, just isn't consulted.
    expect(router).toBeTruthy();
  });

  it('uses ext palette when DISPCNT bit 30 set and a bank is mapped', () => {
    const palBank = 3;
    const colorIdx = 5;
    const { regs, dispcnt } = setup8bppBg(palBank, colorIdx);
    // Make base PRAM color GREEN — we should NOT see this if the ext
    // palette is consulted.
    mem.pram[colorIdx * 2]     = 0xE0;              // BGR555: g=31
    mem.pram[colorIdx * 2 + 1] = 0x03;
    // Map bank E to all 4 BG ext palette slots (Engine A).
    router.vramcnt[4] = 0x84;
    // Engine A BG slot 0 region = vram[BANK_E_OFF + 0..0x1FFF]. Inside
    // that, palBank picks a 512-byte sub-palette, colorIdx*2 is the
    // entry. Stamp BLUE there.
    const slot = 0;                                 // BG0 → ext-palette slot 0
    const off = BANK_E_OFF + slot * 0x2000 + palBank * 512 + colorIdx * 2;
    mem.vram[off]     = 0x00;                       // BGR555: b=31
    mem.vram[off + 1] = 0x7C;
    const out = new Uint8ClampedArray(256 * 4);
    renderTextScanline(mem, regs, 0, dispcnt | (1 << 30), 0, ENGINE_A_BG_VRAM_BASE, out, 0, true);
    // Expect blue.
    expect(out[0]).toBeLessThan(16);
    expect(out[1]).toBeLessThan(16);
    expect(out[2]).toBeGreaterThan(200);
  });

  it('falls back to base PRAM when ext palettes enabled but no bank mapped', () => {
    const palBank = 2;
    const colorIdx = 7;
    const { regs, dispcnt } = setup8bppBg(palBank, colorIdx);
    mem.pram[colorIdx * 2]     = 0x1F;              // pure red in base PRAM
    mem.pram[colorIdx * 2 + 1] = 0x00;
    // DISPCNT bit 30 set but no ext palette bank mapped via VRAMCNT.
    const out = new Uint8ClampedArray(256 * 4);
    renderTextScanline(mem, regs, 0, dispcnt | (1 << 30), 0, ENGINE_A_BG_VRAM_BASE, out, 0, true);
    expect(out[0]).toBeGreaterThan(200);
    expect(out[1]).toBeLessThan(16);
    expect(out[2]).toBeLessThan(16);
  });
});

describe('Sprite: OBJ ext palette rendering', () => {
  let mem: SharedMemory;
  let router: VramRouter;

  function setup8bppSprite(palBank: number, colorIdx: number): {
    dispcnt: number;
  } {
    // OAM entry 0 at oam[0..7]. 8bpp sprite, 8×8, tileNum=0, palBank,
    // x=0, y=0.
    const oam = mem.oam;
    // attr0: y=0, bit 13 (8bpp) = 0x2000.
    oam[0] = 0; oam[1] = 0x20;
    // attr1: x=0, no flip.
    oam[2] = 0; oam[3] = 0;
    // attr2: tileNum=0, priority=0, palBank in bits 12-15.
    oam[4] = 0;
    oam[5] = (palBank << 4) & 0xF0;
    // Tile 0 data at OBJ VRAM base + 0; first pixel = colorIdx.
    mem.vram[ENGINE_A_OBJ_VRAM_BASE] = colorIdx;
    // DISPCNT: 1D mapping (bit 4), OBJ enabled (bit 12), graphics mode (bit 16).
    return { dispcnt: (1 << 16) | (1 << 12) | (1 << 4) };
  }

  beforeEach(() => {
    mem = freshMem();
    router = installRouter();
  });

  it('uses base OBJ PRAM when DISPCNT bit 31 is clear (fallback)', () => {
    const colorIdx = 4;
    const { dispcnt } = setup8bppSprite(/*palBank*/ 5, colorIdx);
    // OBJ PRAM starts at byte 0x200 for engine A. Color idx 4 → byte 0x208.
    mem.pram[0x200 + colorIdx * 2]     = 0x1F;
    mem.pram[0x200 + colorIdx * 2 + 1] = 0x00;
    const line = newObjLine();
    renderObjScanline(mem, 0, 0x200, ENGINE_A_OBJ_VRAM_BASE, dispcnt, 0, 0, line);
    expect(line[0].color).toBe(0x001F);             // red, low 5 bits
    expect(router).toBeTruthy();
  });

  it('uses ext palette when DISPCNT bit 31 set and a bank is mapped', () => {
    const palBank = 7;
    const colorIdx = 4;
    const { dispcnt } = setup8bppSprite(palBank, colorIdx);
    // Base PRAM = green (should NOT win).
    mem.pram[0x200 + colorIdx * 2]     = 0xE0;
    mem.pram[0x200 + colorIdx * 2 + 1] = 0x03;
    // Map bank F MST=5 → Engine A OBJ ext palette.
    router.vramcnt[5] = 0x85;
    // OBJ ext palette: palBank * 512 + colorIdx * 2.
    const off = BANK_F_OFF + palBank * 512 + colorIdx * 2;
    mem.vram[off]     = 0x00;                       // blue
    mem.vram[off + 1] = 0x7C;
    const line = newObjLine();
    renderObjScanline(mem, 0, 0x200, ENGINE_A_OBJ_VRAM_BASE, dispcnt | (1 << 31), 0, 0, line);
    expect(line[0].color).toBe(0x7C00);             // pure blue
  });

  it('falls back to base PRAM when ext palettes enabled but no bank mapped', () => {
    const palBank = 2;
    const colorIdx = 3;
    const { dispcnt } = setup8bppSprite(palBank, colorIdx);
    mem.pram[0x200 + colorIdx * 2]     = 0x1F;      // red
    mem.pram[0x200 + colorIdx * 2 + 1] = 0x00;
    // DISPCNT bit 31 set but no VRAMCNT bank with MST=5/3.
    const line = newObjLine();
    renderObjScanline(mem, 0, 0x200, ENGINE_A_OBJ_VRAM_BASE, dispcnt | (1 << 31), 0, 0, line);
    expect(line[0].color).toBe(0x001F);
  });
});
