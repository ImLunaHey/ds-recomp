// What memory addresses do ARM7 + ARM9 actually write during steady
// state (after boot settles, e.g. frames 50-60)? If neither writes to
// IPC, what shared memory are they using?
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

for (let i = 0; i < 50; i++) emu.runFrame();

const w9 = new Map<number, number>();   // addr → count
const w7 = new Map<number, number>();
const r9 = new Map<number, number>();
const w9o = emu.bus9.write32.bind(emu.bus9);
const w7o = emu.bus7.write32.bind(emu.bus7);
const r9o = emu.bus9.read32.bind(emu.bus9);
emu.bus9.write32 = (a, v) => { if (a < 0x05000000) w9.set(a, (w9.get(a) ?? 0) + 1); return w9o(a, v); };
emu.bus7.write32 = (a, v) => { if (a < 0x05000000) w7.set(a, (w7.get(a) ?? 0) + 1); return w7o(a, v); };
emu.bus9.read32 = (a) => { if (a < 0x05000000) r9.set(a, (r9.get(a) ?? 0) + 1); return r9o(a); };

for (let i = 0; i < 10; i++) emu.runFrame();

function top(label: string, m: Map<number, number>): void {
  const a = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10);
  console.log(`\nTop ${label} write addrs (frames 50-60):`);
  for (const [k, v] of a) console.log(`  0x${k.toString(16)} × ${v}`);
}
top('ARM9 writes', w9);
top('ARM7 writes', w7);
top('ARM9 reads', r9);

// Top ARM9 read PCs (where polling happens)
console.log(`\nARM9 final PC = 0x${emu.cpu9.state.r[15].toString(16)}`);
