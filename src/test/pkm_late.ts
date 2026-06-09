// Diagnose what ARM7/ARM9 are doing at the END of 60 frames — not
// aggregate hot PCs. Track the last few-frames' PC range + any
// IO reads recently to identify the actual blocker.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

for (let i = 0; i < 50; i++) emu.runFrame();

// From this point on, capture stats per frame.
const arm9PcSet = new Set<number>();
const arm7PcSet = new Set<number>();
const arm9IoRd = new Map<number, number>();
const arm7IoRd = new Map<number, number>();
const arm9IoWr = new Map<number, number>();
const arm7IoWr = new Map<number, number>();

const orig9 = emu.cpu9.step.bind(emu.cpu9);
const orig7 = emu.cpu7.step.bind(emu.cpu7);
emu.cpu9.step = () => { arm9PcSet.add(emu.cpu9.state.r[15] & ~3); return orig9(); };
emu.cpu7.step = () => { arm7PcSet.add(emu.cpu7.state.r[15] & ~3); return orig7(); };

const ro9 = emu.bus9.read16.bind(emu.bus9);
const ro7 = emu.bus7.read16.bind(emu.bus7);
const wo9 = emu.bus9.write16.bind(emu.bus9);
const wo7 = emu.bus7.write16.bind(emu.bus7);
emu.bus9.read16 = (a) => { if (a >= 0x04000000 && a < 0x05000000) arm9IoRd.set(a, (arm9IoRd.get(a) ?? 0) + 1); return ro9(a); };
emu.bus7.read16 = (a) => { if (a >= 0x04000000 && a < 0x05000000) arm7IoRd.set(a, (arm7IoRd.get(a) ?? 0) + 1); return ro7(a); };
emu.bus9.write16 = (a, v) => { if (a >= 0x04000000 && a < 0x05000000) arm9IoWr.set(a, (arm9IoWr.get(a) ?? 0) + 1); wo9(a, v); };
emu.bus7.write16 = (a, v) => { if (a >= 0x04000000 && a < 0x05000000) arm7IoWr.set(a, (arm7IoWr.get(a) ?? 0) + 1); wo7(a, v); };

for (let i = 0; i < 10; i++) emu.runFrame();

console.log(`After frames 50-60 (steady state):`);
console.log(`  Distinct ARM9 PCs visited: ${arm9PcSet.size}`);
console.log(`  Distinct ARM7 PCs visited: ${arm7PcSet.size}`);
console.log(`  Final ARM9 PC=0x${emu.cpu9.state.r[15].toString(16)}, ARM7 PC=0x${emu.cpu7.state.r[15].toString(16)}`);

function top(label: string, m: Map<number, number>): void {
  const a = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
  console.log(`\n  ${label}:`);
  for (const [k, v] of a) console.log(`    0x${k.toString(16).padStart(8, '0')}  × ${v.toLocaleString()}`);
}
top('ARM9 IO reads', arm9IoRd);
top('ARM9 IO writes', arm9IoWr);
top('ARM7 IO reads', arm7IoRd);
top('ARM7 IO writes', arm7IoWr);

// Dump a wider PC histogram for ARM7 specifically — its range matters.
const arm7PcSorted = [...arm7PcSet].sort((a, b) => a - b);
if (arm7PcSorted.length) {
  console.log(`\n  ARM7 PC range visited (during 50-60): 0x${arm7PcSorted[0].toString(16)} .. 0x${arm7PcSorted[arm7PcSorted.length-1].toString(16)}`);
}
