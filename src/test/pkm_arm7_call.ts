// Look at the call site that set LR=0x037faed0 — that's the function
// call that landed ARM7 in the zero region.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

for (let i = 0; i < 50; i++) emu.runFrame();

const SITE = 0x037faecc;
console.log(`Disasm 16 insns around 0x${SITE.toString(16)}:`);
for (let a = SITE - 32; a < SITE + 32; a += 4) {
  const w = emu.bus7.read32(a);
  const m = (a === SITE) ? ' <<<' : '';
  console.log(`  0x${a.toString(16)}  ${w.toString(16).padStart(8, '0')}${m}`);
}

console.log(`\nDisasm 16 around 0x37fade4 (where ARM7 enters zero region):`);
for (let a = 0x37fadc0; a < 0x37fae00; a += 4) {
  const w = emu.bus7.read32(a);
  console.log(`  0x${a.toString(16)}  ${w.toString(16).padStart(8, '0')}`);
}

// Also dump where the zero region BEGINS — walk backwards until we hit a non-zero word.
let firstZero = 0x037fae28;
for (let a = 0x37faed0; a > 0x037f8000; a -= 4) {
  const w = emu.bus7.read32(a);
  if (w !== 0) { firstZero = a + 4; break; }
}
console.log(`\nFirst zero word at 0x${firstZero.toString(16)} (walking back from LR).`);
