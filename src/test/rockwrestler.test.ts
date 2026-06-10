// RockWrestler boot + heartbeat + menu navigation tests. The per-
// category sub-test matrix lives in rockwrestler_<category>.test.ts
// so vitest can run all 6 in parallel.

import { describe, it, expect, beforeAll } from 'vitest';
import type { Emulator } from '../emulator';
import { freshEmulator, pressKey, tileLitCount, haveRom, KEY } from './rockwrestler_helpers';

describe.skipIf(!haveRom)('RockWrestler boot + heartbeat', () => {
  let emu: Emulator;
  beforeAll(() => { emu = freshEmulator(); });

  it('boots both CPUs and reaches the menu', () => {
    expect(emu.cpu9.state.r[15]).toBeGreaterThan(0x02000000);
    expect(emu.cpu7.state.r[15]).toBeGreaterThan(0x03800000);
    expect(emu.ppu.dispcntA & 0x30000).toBe(0x20000);
    expect(emu.ppu.vramcnt[0]).toBe(0x80);
  });

  it('IPC SYNC handshake completes (s9 ↔ s7 oscillate 1/2)', () => {
    const a = new Set<string>();
    for (let i = 0; i < 30; i++) {
      emu.runFrame();
      a.add(`${emu.ipc.sync9Out}-${emu.ipc.sync7Out}`);
    }
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
    const before = tileLitCount(emu, 1, 2);
    pressKey(emu, KEY.DOWN, 1, 4);
    const after = tileLitCount(emu, 1, 3);
    expect(after).toBeGreaterThan(2);
    expect(tileLitCount(emu, 1, 2)).toBeLessThanOrEqual(before);
  });
});
