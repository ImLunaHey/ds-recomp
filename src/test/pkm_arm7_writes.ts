// Track ARM7 writes to the IWRAM relocation target (0x037F8000+)
// during boot. We want to know which ranges get populated and which
// stay zero — that tells us if the autoload completed properly.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const written = new Set<number>();           // word-offsets within 0x037F8000+0x10000
const ranges: Array<[number, number]> = [];  // contiguous-write runs (PC source)

const w32 = emu.bus7.write32.bind(emu.bus7);
const w16 = emu.bus7.write16.bind(emu.bus7);
const w8  = emu.bus7.write8.bind(emu.bus7);
emu.bus7.write32 = (a, v) => { mark(a, 4); w32(a, v); };
emu.bus7.write16 = (a, v) => { mark(a, 2); w16(a, v); };
emu.bus7.write8  = (a, v) => { mark(a, 1); w8(a, v); };
function mark(addr: number, n: number) {
  if (addr >= 0x037F8000 && addr < 0x03808000) {
    for (let i = 0; i < n; i++) written.add(addr + i);
  }
  if (addr >= 0x037F8000 && addr < 0x03808000) {
    const pc = emu.cpu7.state.r[15] & ~3;
    const last = ranges[ranges.length - 1];
    if (!last || last[1] !== addr) ranges.push([pc, addr + n]);
    else last[1] = addr + n;
  }
}

for (let i = 0; i < 30; i++) emu.runFrame();

console.log(`Total IWRAM bytes written: ${written.size}`);

// Find which ranges are NEVER written within 0x037F8000..0x03808000.
let gaps: Array<[number, number]> = [];
let i = 0x037F8000;
while (i < 0x03808000) {
  if (written.has(i)) { i++; continue; }
  const start = i;
  while (i < 0x03808000 && !written.has(i)) i++;
  if (i - start > 0x40) gaps.push([start, i]);  // only gaps > 64 bytes
}
console.log(`\nGaps in IWRAM > 64 bytes (never written):`);
for (const [s, e] of gaps.slice(0, 10)) {
  console.log(`  0x${s.toString(16)} .. 0x${e.toString(16)}  (${e - s} bytes)`);
}

// Top write-source PCs (which code is doing the autoload copy?)
const pcWrites = new Map<number, number>();
for (const [pc] of ranges) pcWrites.set(pc, (pcWrites.get(pc) ?? 0) + 1);
const topPcs = [...pcWrites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`\nTop write-source PCs:`);
for (const [pc, n] of topPcs) console.log(`  PC=0x${pc.toString(16)} × ${n}`);
