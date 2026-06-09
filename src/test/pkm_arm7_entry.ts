// Dump the ARM7 entry code from 0x02380000 onwards.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';
const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const start = 0x02380100;
console.log(`ARM7 code 0x${start.toString(16)}+:`);
for (let a = start; a < start + 512; a += 4) {
  const w = emu.bus7.read32(a);
  console.log(`  0x${a.toString(16)}  ${w.toString(16).padStart(8, '0')}`);
}
