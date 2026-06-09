// What's actually at 0x01FF8000 after autoload completes.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

for (let i = 0; i < 10; i++) emu.runFrame();

console.log('First 64 bytes at 0x01FF8000 (autoload entry 0 dest):');
let row = '';
for (let i = 0; i < 64; i++) {
  row += emu.bus9.read8(0x01FF8000 + i).toString(16).padStart(2, '0') + ' ';
  if ((i & 15) === 15) { console.log('  ' + row); row = ''; }
}

console.log('\nBytes at 0x01FF8554 (the BL target):');
row = '';
for (let i = 0; i < 64; i++) {
  row += emu.bus9.read8(0x01FF8554 + i).toString(16).padStart(2, '0') + ' ';
  if ((i & 15) === 15) { console.log('  ' + row); row = ''; }
}

console.log(`\nBytes at 0x027E0000 (autoload entry 1 dest):`);
row = '';
for (let i = 0; i < 64; i++) {
  row += emu.bus9.read8(0x027E0000 + i).toString(16).padStart(2, '0') + ' ';
  if ((i & 15) === 15) { console.log('  ' + row); row = ''; }
}
