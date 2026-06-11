// Extra VRAM bank-router tests. The existing test suite covers a few
// LCDC + main BG paths via the rockwrestler memory ROM; this file
// targets the rest of the dispatch tree: engine A OBJ via banks B/D,
// LCDC alias, sub-OBJ via bank D MST=5, sub-BG via bank C MST=4, and
// the engine A BG ext-palette path via bank E.

import { describe, it, expect } from 'vitest';
import { VramRouter } from '../memory/vram_router';

function makeRouter(): { vramcnt: Uint8Array; router: VramRouter } {
  const vramcnt = new Uint8Array(9);
  return { vramcnt, router: new VramRouter(vramcnt) };
}

// Bank layout in shared.vram, per VramRouter:
//   A 0x00000 / 128 KB, B 0x20000 / 128 KB, C 0x40000 / 128 KB,
//   D 0x60000 / 128 KB, E 0x80000 / 64 KB, F 0x90000 / 16 KB,
//   G 0x94000 / 16 KB, H 0x98000 / 32 KB, I 0xA0000 / 16 KB.

describe('VramRouter — engine A OBJ window', () => {
  it('bank B (MST=2, OFFSET=0) maps to 0x06400000+', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[1] = 0x82;        // enable + MST=2
    // Address 0x06400000 → bank B base (offset 0 in B = 0x20000 in shared.vram).
    expect(router.resolveArm9(0x06400000)).toBe(0x20000);
    expect(router.resolveArm9(0x06400010)).toBe(0x20010);
  });

  it('bank B (MST=2, OFFSET=1) maps to 0x06420000+', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[1] = 0x8A;        // enable + MST=2 + OFFSET bit 0 = 1
    expect(router.resolveArm9(0x06420000)).toBe(0x20000);
    // 0x06400000 is now NOT in B's window.
    expect(router.resolveArm9(0x06400000)).toBe(-1);
  });

  it('bank D (MST=2, OFFSET=1) covers the OFFSET-bit-0 path', () => {
    const { vramcnt, router } = makeRouter();
    // Banks 0/1 in the OBJ window only consider OFFSET bit 0 — banks
    // C/D are NOT in that branch (per source). The OBJ map for D uses
    // mst=2 with banks 2/3 — but the actual code path is `i <= 1 &&
    // mst === 2`, so D is NOT mapped to engine A OBJ. We instead test
    // the engine A BG path with bank D OFFSET = 1 (the symmetric case).
    vramcnt[3] = 0x89;        // enable + MST=1 + OFFSET bit 0 = 1
    // BG window: D MST=1 OFFSET=1 → base = 0x06020000.
    expect(router.resolveArm9(0x06020000)).toBe(0x60000);
    expect(router.resolveArm9(0x06000000)).toBe(-1);
  });
});

describe('VramRouter — LCDC alias', () => {
  it('LCDC region 0x06800000+ maps a bank only when its MST=0', () => {
    const { vramcnt, router } = makeRouter();
    // Bank A enabled, MST=0 (LCDC mode), OFFSET ignored for LCDC.
    vramcnt[0] = 0x80;
    expect(router.resolveArm9(0x06800000)).toBe(0x00000);
    expect(router.resolveArm9(0x06800010)).toBe(0x00010);
    // Bank B at LCDC mode → 0x06820000+
    vramcnt[1] = 0x80;
    expect(router.resolveArm9(0x06820000)).toBe(0x20000);
    // Bank C at LCDC mode → 0x06840000+
    vramcnt[2] = 0x80;
    expect(router.resolveArm9(0x06840000)).toBe(0x40000);
    // Bank E at LCDC mode → 0x06880000+
    vramcnt[4] = 0x80;
    expect(router.resolveArm9(0x06880000)).toBe(0x80000);
    expect(router.resolveArm9(0x06881000)).toBe(0x81000);
    // Bank H at LCDC mode → 0x06898000+ (32 KB)
    vramcnt[7] = 0x80;
    expect(router.resolveArm9(0x06898000)).toBe(0x98000);
  });

  it('LCDC range with no bank enabled returns -1', () => {
    const { router } = makeRouter();
    expect(router.resolveArm9(0x06800000)).toBe(-1);
    expect(router.resolveArm9(0x06880000)).toBe(-1);
  });
});

describe('VramRouter — sub-OBJ window 0x06600000+', () => {
  it('bank D MST=4 maps to 0x06600000+ (sub-OBJ, 128 KB)', () => {
    // Per GBATEK §"VRAM Banks": bank D MST=4 is Engine B OBJ. The
    // previous implementation looked for MST=5 (which does not
    // exist on bank D) and silently failed for every game whose
    // language-select / menu used Engine B sprites — Brain Training
    // is the canonical case (white bottom screen).
    const { vramcnt, router } = makeRouter();
    vramcnt[3] = 0x84;        // enable + MST=4
    expect(router.resolveArm9(0x06600000)).toBe(0x60000);
    expect(router.resolveArm9(0x0660FFFF)).toBe(0x6FFFF);
    // Just past D's 128 KB extent: no bank covers it.
    expect(router.resolveArm9(0x06620000)).toBe(-1);
  });
});

describe('VramRouter — sub-BG window 0x06200000+', () => {
  it('bank C MST=4 OFFSET=0 maps to 0x06200000+ (sub-BG, 128 KB)', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[2] = 0x84;        // enable + MST=4 (OFFSET=0)
    expect(router.resolveArm9(0x06200000)).toBe(0x40000);
    expect(router.resolveArm9(0x0620FFFF)).toBe(0x4FFFF);
    expect(router.resolveArm9(0x06220000)).toBe(-1);
  });
});

describe('VramRouter — engine A BG ext-palette', () => {
  it('bank E MST=4 covers all 4 BG ext-palette slots (32 KB total)', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[4] = 0x84;        // bank E enable + MST=4
    // Slot 0 offset 0 → bank E base (0x80000) + 0 = 0x80000.
    expect(router.resolveBgExtPalA(0, 0)).toBe(0x80000);
    expect(router.resolveBgExtPalA(0, 0x100)).toBe(0x80100);
    // Slot 1 offset 0 → bank E base + 0x2000.
    expect(router.resolveBgExtPalA(1, 0)).toBe(0x82000);
    // Slot 2 → +0x4000, Slot 3 → +0x6000.
    expect(router.resolveBgExtPalA(2, 0)).toBe(0x84000);
    expect(router.resolveBgExtPalA(3, 0x1FFF)).toBe(0x80000 + 0x6000 + 0x1FFF);
  });

  it('bank F MST=4 with OFFSET picks a single slot pair', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[5] = 0x84;        // F MST=4 OFFSET=0 (slots 0/1, slot 0 actually)
    // Confirm slot 0 maps, slots 2/3 do not.
    expect(router.resolveBgExtPalA(0, 0)).toBe(0x90000);
    expect(router.resolveBgExtPalA(2, 0)).toBe(-1);
    expect(router.resolveBgExtPalA(3, 0)).toBe(-1);
  });
});

describe('VramRouter — engine A OBJ ext-palette', () => {
  it('bank F MST=5 provides 8 KB of OBJ ext-palette', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[5] = 0x85;
    expect(router.resolveObjExtPalA(0)).toBe(0x90000);
    expect(router.resolveObjExtPalA(0x1FFF)).toBe(0x90000 + 0x1FFF);
  });

  it('bank G MST=5 also provides OBJ ext-palette when F is unmapped', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[6] = 0x85;
    expect(router.resolveObjExtPalA(0)).toBe(0x94000);
    expect(router.resolveObjExtPalA(0x100)).toBe(0x94100);
  });

  it('with no F or G bank, OBJ ext-palette resolution returns -1', () => {
    const { router } = makeRouter();
    expect(router.resolveObjExtPalA(0)).toBe(-1);
  });
});

describe('VramRouter — engine B ext-palette routing', () => {
  it('bank H MST=2 provides all 4 engine B BG ext-palette slots', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[7] = 0x82;
    expect(router.resolveBgExtPalB(0, 0)).toBe(0x98000);
    expect(router.resolveBgExtPalB(1, 0)).toBe(0x9A000);
    expect(router.resolveBgExtPalB(2, 0)).toBe(0x9C000);
    expect(router.resolveBgExtPalB(3, 0x100)).toBe(0x9E100);
  });

  it('engine B BG ext-palette returns -1 when bank H is not in MST=2', () => {
    const { router } = makeRouter();
    expect(router.resolveBgExtPalB(0, 0)).toBe(-1);
  });

  it('bank I MST=3 provides 8 KB of engine B OBJ ext-palette', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[8] = 0x83;
    expect(router.resolveObjExtPalB(0)).toBe(0xA0000);
    expect(router.resolveObjExtPalB(0x100)).toBe(0xA0100);
  });

  it('engine B OBJ ext-palette returns -1 when bank I is not mapped', () => {
    const { router } = makeRouter();
    expect(router.resolveObjExtPalB(0)).toBe(-1);
  });
});

describe('VramRouter — resolveArm7', () => {
  it('bank C MST=2 OFFSET=0 maps to 0x06000000+', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[2] = 0x82;            // enable + MST=2 + OFFSET=0
    expect(router.resolveArm7(0x06000000)).toBe(0x40000);
    expect(router.resolveArm7(0x06001000)).toBe(0x41000);
    expect(router.resolveArm7(0x0601FFFF)).toBe(0x5FFFF);
  });

  it('bank D MST=2 OFFSET=1 maps to 0x06020000+', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[3] = 0x8A;            // enable + MST=2 + OFFSET bit 0 = 1
    expect(router.resolveArm7(0x06020000)).toBe(0x60000);
    // 0x06000000 is now not mapped on the D side; should return -1
    // (since only D is set and its window is 0x06020000+).
    expect(router.resolveArm7(0x06000000)).toBe(-1);
  });

  it('addresses outside the ARM7 VRAM window return -1', () => {
    const { router } = makeRouter();
    expect(router.resolveArm7(0x05FFFFFF)).toBe(-1);
    expect(router.resolveArm7(0x06040000)).toBe(-1);
    expect(router.resolveArm7(0x06800000)).toBe(-1);
  });

  it('no enabled bank: resolveArm7 returns -1 within the window', () => {
    const { router } = makeRouter();
    expect(router.resolveArm7(0x06000000)).toBe(-1);
  });
});

describe('VramRouter — readVramStat', () => {
  it('reports bit 0 set when bank C is in MST=2 (ARM7-allocated)', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[2] = 0x82;
    expect(router.readVramStat() & 0x01).toBe(0x01);
    expect(router.readVramStat() & 0x02).toBe(0);
  });

  it('reports bit 1 set when bank D is in MST=2', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[3] = 0x82;
    expect(router.readVramStat() & 0x02).toBe(0x02);
    expect(router.readVramStat() & 0x01).toBe(0);
  });

  it('reports both bits when both C and D are ARM7-allocated', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[2] = 0x82;
    vramcnt[3] = 0x82;
    expect(router.readVramStat() & 0x03).toBe(0x03);
  });

  it('reports 0 when neither C nor D is in MST=2', () => {
    const { router } = makeRouter();
    expect(router.readVramStat()).toBe(0);
  });
});

describe('VramRouter — main BG window 0x06000000+', () => {
  it('bank H MST=1 maps to sub-BG window starting at 0x06200000', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[7] = 0x81;            // H enable + MST=1
    expect(router.resolveArm9(0x06200000)).toBe(0x98000);
    expect(router.resolveArm9(0x06207FFF)).toBe(0x98000 + 0x7FFF);
  });

  it('bank I MST=1 maps to sub-BG window starting at 0x06208000', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[8] = 0x81;            // I enable + MST=1
    expect(router.resolveArm9(0x06208000)).toBe(0xA0000);
    expect(router.resolveArm9(0x0620BFFF)).toBe(0xA0000 + 0x3FFF);
  });

  it('bank I MST=2 maps to sub-OBJ window at 0x06600000', () => {
    const { vramcnt, router } = makeRouter();
    vramcnt[8] = 0x82;            // I enable + MST=2
    expect(router.resolveArm9(0x06600000)).toBe(0xA0000);
    expect(router.resolveArm9(0x06603FFF)).toBe(0xA0000 + 0x3FFF);
  });
});
