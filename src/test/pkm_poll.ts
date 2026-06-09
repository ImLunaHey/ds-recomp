// Track ARM9 reads where the read address ≠ the PC + small (i.e.
// data reads, not instruction fetches). Those are the variables
// it's polling on.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

for (let i = 0; i < 50; i++) emu.runFrame();

const data9 = new Map<number, number>();
const r32o = emu.bus9.read32.bind(emu.bus9);
const r16o = emu.bus9.read16.bind(emu.bus9);
const r8o  = emu.bus9.read8.bind(emu.bus9);
function track(a: number) {
  const pc = emu.cpu9.state.r[15] & ~3;
  if (Math.abs(a - pc) > 64 && a < 0x05000000) {
    data9.set(a, (data9.get(a) ?? 0) + 1);
  }
}
emu.bus9.read32 = (a) => { track(a); return r32o(a); };
emu.bus9.read16 = (a) => { track(a); return r16o(a); };
emu.bus9.read8  = (a) => { track(a); return r8o(a); };

for (let i = 0; i < 10; i++) emu.runFrame();

const top = [...data9.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`ARM9 data reads (frames 50-60):`);
for (const [a, n] of top) console.log(`  0x${a.toString(16).padStart(8, '0')} × ${n.toLocaleString()}`);

console.log(`\nSample values at top addresses:`);
for (const [a] of top.slice(0, 8)) {
  console.log(`  0x${a.toString(16)}: 0x${emu.bus9.read32(a).toString(16)}`);
}
