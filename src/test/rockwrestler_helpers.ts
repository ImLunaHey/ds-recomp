// Shared helpers for the RockWrestler integration tests. Each sub-test
// file imports from here and runs a tightly-scoped chunk in parallel
// with the others — splitting the originally ~80 s serial suite into
// ~13 s wall-clock across 6 workers.

import { readFileSync, existsSync } from 'node:fs';
import { Emulator } from '../emulator';

export const ROM_PATH = 'public/rockwrestler.nds';
export const KEY = { A: 1 << 0, B: 1 << 1, UP: 1 << 6, DOWN: 1 << 7 } as const;
export const haveRom = existsSync(ROM_PATH);

export function pressKey(emu: Emulator, bit: number, hold = 1, release = 4): void {
  emu.io9.keyinput &= ~bit;
  emu.io7.keyinput &= ~bit;
  for (let i = 0; i < hold; i++) emu.runFrame();
  emu.io9.keyinput |= bit;
  emu.io7.keyinput |= bit;
  for (let i = 0; i < release; i++) emu.runFrame();
}

export function freshEmulator(): Emulator {
  const rom = readFileSync(ROM_PATH);
  const emu = new Emulator();
  emu.loadRom(rom);
  for (let i = 0; i < 30; i++) emu.runFrame();
  return emu;
}

export function tileLitCount(emu: Emulator, tx: number, ty: number): number {
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

export function looksLikeOk(emu: Emulator): boolean {
  const c0 = tileLitCount(emu, 0, 0);
  const c1 = tileLitCount(emu, 1, 0);
  const c2 = tileLitCount(emu, 2, 0);
  return c0 > 6 && c1 > 6 && c2 < 4;
}

export type Child = { name: string; type: 0 | 2 };
export const SUBMENUS: Array<{ name: string; children: Child[] }> = [
  { name: 'ARMv4', children: [
    { name: 'CONDITION CODES', type: 0 },
  ]},
  { name: 'ARMv5', children: [
    { name: 'CLZ', type: 0 },
    { name: 'QADD, QSUB', type: 0 },
    { name: 'QDADD, QDSUB', type: 0 },
    { name: 'SMULxy', type: 0 },
    { name: 'SMLAxy', type: 0 },
    { name: 'SMULWy', type: 0 },
    { name: 'SMLAWy', type: 0 },
    { name: 'SMLALxy', type: 0 },
    { name: 'BLX', type: 0 },
    { name: 'LDR r15, POP {r15}, LDM {r15}', type: 0 },
    { name: 'LDM / STM', type: 0 },
  ]},
  { name: 'IPC', children: [
    { name: 'IPCSYNC', type: 0 },
    { name: 'IPCFIFO', type: 0 },
    { name: 'IPCFIFO IRQ', type: 0 },
  ]},
  { name: 'DS MATH', children: [
    { name: 'SQRT 32', type: 0 },
    { name: 'SQRT 64', type: 0 },
    { name: 'DIV 32/32', type: 0 },
    { name: 'DIV 64/32', type: 0 },
    { name: 'DIV 64/64', type: 0 },
  ]},
  { name: 'MEMORY', children: [
    { name: 'WRAM CNT', type: 0 },
    { name: 'VRAM CNT', type: 0 },
    { name: 'TCM', type: 0 },
  ]},
  { name: 'INITIAL STATE', children: [
    { name: 'IPC/IRQ/CPSR', type: 2 },
    { name: 'CP15', type: 2 },
  ]},
];

// Run one sub-test through the menu: select category i, then child j,
// wait for OK (type 0) or print output (type 2).
export function runSubTest(categoryIndex: number, childIndex: number, child: Child): boolean {
  const emu = freshEmulator();
  for (let n = 0; n < categoryIndex; n++) pressKey(emu, KEY.DOWN, 1, 4);
  pressKey(emu, KEY.A, 1, 4);
  for (let n = 0; n < childIndex; n++) pressKey(emu, KEY.DOWN, 1, 4);
  pressKey(emu, KEY.A, 1, 60);
  const expectedToDrawOk = child.type === 0;
  const cap = expectedToDrawOk ? 1200 : 200;
  for (let f = 0; f < cap; f++) {
    emu.runFrame();
    if (expectedToDrawOk && looksLikeOk(emu)) break;
  }
  if (expectedToDrawOk) return looksLikeOk(emu);
  let lit = 0;
  for (let x = 0; x < 256; x++) {
    const off = ((3 * 8 + 3) * 256 + x) * 2;
    const c = (emu.mem.vram[off] | (emu.mem.vram[off + 1] << 8)) & 0x7FFF;
    if (c !== 0x56B5) lit++;
  }
  return lit > 10;
}
