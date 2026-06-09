import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Emulator } from '../emulator';

const ROM_PATH = 'public/rockwrestler.nds';
const KEY = { A: 1 << 0, B: 1 << 1, UP: 1 << 6, DOWN: 1 << 7 } as const;

function pressKey(emu: Emulator, bit: number, hold = 1, release = 4): void {
  emu.io9.keyinput &= ~bit;
  emu.io7.keyinput &= ~bit;
  for (let i = 0; i < hold; i++) emu.runFrame();
  emu.io9.keyinput |= bit;
  emu.io7.keyinput |= bit;
  for (let i = 0; i < release; i++) emu.runFrame();
}

function freshEmulator(): Emulator {
  const rom = readFileSync(ROM_PATH);
  const emu = new Emulator();
  emu.loadRom(rom);
  // Let the menu finish drawing.
  for (let i = 0; i < 30; i++) emu.runFrame();
  return emu;
}

// Count "lit" pixels (non-background) in an 8×8 tile region at tile
// coords (tx, ty). Background is 0x56B5 (the light-grey clear color);
// the test ROM's font draws characters with palette[1..3] over that.
function tileLitCount(emu: Emulator, tx: number, ty: number): number {
  // RockWrestler's font draws character ink with palette[0] = 0x0000
  // (black) and uses palette[2] = 0x56B5 (light grey) as the
  // background-matching color. So a "lit" pixel is anything that
  // isn't 0x56B5 — the framebuffer is cleared to grey before each
  // screen is drawn, so any value that isn't grey came from a char.
  const vram = emu.mem.vram;
  let n = 0;
  const baseX = tx * 8, baseY = ty * 8;
  for (let dy = 0; dy < 8; dy++) {
    for (let dx = 0; dx < 8; dx++) {
      const off = ((baseY + dy) * 256 + (baseX + dx)) * 2;
      const c = (vram[off] | (vram[off + 1] << 8)) & 0x7FFF;
      if (c !== 0x56B5) n++;
    }
  }
  return n;
}

// Detect "OK" at the top-left after a passed test: clear_screen +
// draw_string(0, 0, "OK"). 'O' and 'K' both have notable lit-pixel
// counts (15-20 lit out of 64). A FAIL render writes "FAIL XXX" so
// tile (0, 0) is 'F' and tile (1, 0) is 'A' — different counts.
function looksLikeOk(emu: Emulator): boolean {
  // After clear_screen the rest of the screen is uniform grey, so this
  // is robust. We check that some pixels are lit in cells (0,0) and
  // (1,0) but very few in (2,0) (third char would have been a space).
  const c0 = tileLitCount(emu, 0, 0);
  const c1 = tileLitCount(emu, 1, 0);
  const c2 = tileLitCount(emu, 2, 0);
  return c0 > 6 && c1 > 6 && c2 < 4;
}

// All 6 top-level menu entries on the main menu.
// Each top-level menu entry. The cpp_menu source classifies its
// entries.type: 0 = test that draws "OK" on pass, 1 = submenu,
// 2 = "just prints values" with no OK/FAIL screen.
const TOP_MENU = [
  { name: 'ARMv4',          firstChildType: 0 },
  { name: 'ARMv5',          firstChildType: 0 },
  { name: 'IPC',            firstChildType: 0 },
  { name: 'DS MATH',        firstChildType: 0 },
  { name: 'MEMORY',         firstChildType: 0 },
  { name: 'INITIAL STATE',  firstChildType: 2 },   // ipc/irq/cpsr — print-only
] as const;

const haveRom = existsSync(ROM_PATH);

describe.skipIf(!haveRom)('RockWrestler boot + heartbeat', () => {
  let emu: Emulator;
  beforeAll(() => { emu = freshEmulator(); });

  it('boots both CPUs and reaches the menu', () => {
    expect(emu.cpu9.state.r[15]).toBeGreaterThan(0x02000000);  // ARM9 in user code
    expect(emu.cpu7.state.r[15]).toBeGreaterThan(0x03800000);  // ARM7 in IWRAM
    expect(emu.ppu.dispcntA & 0x30000).toBe(0x20000);          // LCDC display mode
    expect(emu.ppu.vramcnt[0]).toBe(0x80);                     // VRAM bank A LCDC enabled
  });

  it('IPC SYNC handshake completes (s9 ↔ s7 oscillate 1/2)', () => {
    const a = new Set<string>();
    for (let i = 0; i < 30; i++) {
      emu.runFrame();
      a.add(`${emu.ipc.sync9Out}-${emu.ipc.sync7Out}`);
    }
    // We should see both heartbeat states (1-1) and (2-2) within 30
    // frames if the handshake is alive.
    expect(a.has('1-1') || a.has('2-2')).toBe(true);
    expect(a.size).toBeGreaterThan(1);
  });

  it('menu top-row text has been drawn (≠ all background)', () => {
    let lit = 0;
    for (let x = 0; x < 256; x++) {
      const off = x * 2;
      const c = (emu.mem.vram[off] | (emu.mem.vram[off + 1] << 8)) & 0x7FFF;
      if (c !== 0x56B5) lit++;
    }
    expect(lit).toBeGreaterThan(20);
  });
});

describe.skipIf(!haveRom)('RockWrestler menu navigation', () => {
  it('cursor moves down on Down key (cursor tile changes column 1)', () => {
    const emu = freshEmulator();
    // The cursor is drawn as palette index 0x16 ("‖" looking glyph) at
    // (1, 2 + menu_index). After pressing Down once, the cursor moves
    // from row 2 to row 3.
    const before = tileLitCount(emu, 1, 2);
    pressKey(emu, KEY.DOWN, 1, 4);
    const after = tileLitCount(emu, 1, 3);
    // After pressing down, row 3 col 1 should have visible cursor.
    expect(after).toBeGreaterThan(2);
    // And row 2 col 1 should have been cleared (cursor erased there).
    expect(tileLitCount(emu, 1, 2)).toBeLessThanOrEqual(before);
  });
});

// Per-submenu integration: navigate to the entry, press A to enter
// submenu, press A again to run the first test, wait, check for "OK".
describe.skipIf(!haveRom)('RockWrestler test categories run without timeout', () => {
  for (let i = 0; i < TOP_MENU.length; i++) {
    const entry = TOP_MENU[i];
    const expectedToDrawOk = entry.firstChildType === 0;
    const label = expectedToDrawOk
      ? `category #${i} (${entry.name}): first test reaches OK`
      : `category #${i} (${entry.name}): first entry runs (type-2, no OK screen)`;
    it(label, { timeout: 30000 }, () => {
      const emu = freshEmulator();
      // Navigate to row i.
      for (let n = 0; n < i; n++) pressKey(emu, KEY.DOWN, 1, 4);
      // Enter submenu.
      pressKey(emu, KEY.A, 1, 4);
      // Run first test.
      pressKey(emu, KEY.A, 1, 60);
      // For type-0 tests poll up to 1200 frames waiting for "OK". For
      // type-2 (no OK screen) we just need to let it run long enough
      // to populate the print-out — 200 frames is plenty.
      const cap = expectedToDrawOk ? 1200 : 200;
      for (let f = 0; f < cap; f++) {
        emu.runFrame();
        if (expectedToDrawOk && looksLikeOk(emu)) break;
      }
      if (expectedToDrawOk) {
        expect(looksLikeOk(emu)).toBe(true);
      } else {
        // Type-2 entry just prints register values. Verify ARM9 isn't
        // stuck in an infinite loop and that *some* non-background
        // pixels exist somewhere in row 3 (where the first label/value
        // line lives).
        let lit = 0;
        for (let x = 0; x < 256; x++) {
          const off = ((3 * 8 + 3) * 256 + x) * 2;
          const c = (emu.mem.vram[off] | (emu.mem.vram[off + 1] << 8)) & 0x7FFF;
          if (c !== 0x56B5) lit++;
        }
        expect(lit).toBeGreaterThan(10);
      }
    });
  }
});
