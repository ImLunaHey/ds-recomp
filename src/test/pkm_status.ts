// Comprehensive Pokemon Platinum boot status: where each CPU is stuck,
// what IO they're polling, what came closest to a DISPCNT write.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const arm9Pcs = new Map<number, number>();
const arm7Pcs = new Map<number, number>();
const ioReads9 = new Map<number, number>();
const ioReads7 = new Map<number, number>();

const orig9 = emu.cpu9.step.bind(emu.cpu9);
const orig7 = emu.cpu7.step.bind(emu.cpu7);
emu.cpu9.step = () => {
  const pc = emu.cpu9.state.r[15] & ~3;
  arm9Pcs.set(pc, (arm9Pcs.get(pc) ?? 0) + 1);
  return orig9();
};
emu.cpu7.step = () => {
  const pc = emu.cpu7.state.r[15] & ~3;
  arm7Pcs.set(pc, (arm7Pcs.get(pc) ?? 0) + 1);
  return orig7();
};

const ro9 = emu.bus9.read16.bind(emu.bus9);
const ro7 = emu.bus7.read16.bind(emu.bus7);
emu.bus9.read16 = (a) => { if (a >= 0x04000000 && a < 0x05000000) ioReads9.set(a, (ioReads9.get(a) ?? 0) + 1); return ro9(a); };
emu.bus7.read16 = (a) => { if (a >= 0x04000000 && a < 0x05000000) ioReads7.set(a, (ioReads7.get(a) ?? 0) + 1); return ro7(a); };

for (let i = 0; i < 60; i++) emu.runFrame();

console.log(`After 60 frames:`);
console.log(`  ARM9 PC = 0x${emu.cpu9.state.r[15].toString(16)}`);
console.log(`  ARM7 PC = 0x${emu.cpu7.state.r[15].toString(16)}`);
console.log(`  IPC SYNC s9=${emu.ipc.sync9Out} s7=${emu.ipc.sync7Out}`);
console.log(`  DISPCNT_A = 0x${emu.ppu.dispcntA.toString(16)}  DISPCNT_B = 0x${emu.ppu.dispcntB.toString(16)}`);
console.log(`  IME9=${emu.irq9.ime} IE9=0x${emu.irq9.ie.toString(16)}`);
console.log(`  IME7=${emu.irq7.ime} IE7=0x${emu.irq7.ie.toString(16)}`);

function topN(label: string, m: Map<number, number>, n = 5): void {
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log(`\nHottest ${label}:`);
  for (const [k, v] of sorted) console.log(`  0x${k.toString(16).padStart(8, '0')}  × ${v.toLocaleString()}`);
}

topN('ARM9 PCs', arm9Pcs);
topN('ARM7 PCs', arm7Pcs);
topN('ARM9 IO reads', ioReads9);
topN('ARM7 IO reads', ioReads7);
