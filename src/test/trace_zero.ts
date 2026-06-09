// Find what zeroes the autoload source data. We trace every ARM9
// write to main RAM offset 0x101D20..0x021023E0 and report the PC
// that did it.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const HOT_LO = 0x02101D20, HOT_HI = 0x021023E0;
const writers = new Map<number, number>();   // pc → count

const w32o = emu.bus9.write32.bind(emu.bus9);
const w16o = emu.bus9.write16.bind(emu.bus9);
const w8o  = emu.bus9.write8.bind(emu.bus9);
function track(a: number) {
  if (a >= HOT_LO && a < HOT_HI) {
    const pc = emu.cpu9.state.r[15] & ~3;
    writers.set(pc, (writers.get(pc) ?? 0) + 1);
  }
}
emu.bus9.write32 = (a, v) => { track(a); w32o(a, v); };
emu.bus9.write16 = (a, v) => { track(a); w16o(a, v); };
emu.bus9.write8  = (a, v) => { track(a); w8o(a, v); };

for (let i = 0; i < 10; i++) emu.runFrame();

console.log(`Writers to 0x${HOT_LO.toString(16)}..0x${HOT_HI.toString(16)}:`);
for (const [pc, n] of [...writers.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  PC=0x${pc.toString(16)}  × ${n}`);
}
