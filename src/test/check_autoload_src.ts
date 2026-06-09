// Compare what's in the ROM at the autoload source offset vs what
// ends up in main RAM after our load + overlay phases.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';
import { parseNdsHeader } from '../cart/header';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const header = parseNdsHeader(rom);
console.log(`arm9RomOffset = 0x${header.arm9RomOffset.toString(16)}`);
console.log(`arm9RamAddr   = 0x${header.arm9RamAddr.toString(16)}`);
console.log(`arm9Size      = 0x${header.arm9Size.toString(16)}`);

// Source addr in RAM: 0x02101D20. Offset into binary: 0x101D20.
const srcRomOff = header.arm9RomOffset + 0x101D20;
console.log(`\nROM bytes at offset 0x${srcRomOff.toString(16)} (expected autoload source):`);
let row = '';
for (let i = 0; i < 64; i++) {
  row += rom[srcRomOff + i].toString(16).padStart(2, '0') + ' ';
  if ((i & 15) === 15) { console.log('  ' + row); row = ''; }
}

const emu = new Emulator();
emu.loadRom(rom);
console.log(`\nAfter loadRom() (binary + overlays loaded), main RAM at 0x02101D20:`);
row = '';
for (let i = 0; i < 64; i++) {
  row += emu.bus9.read8(0x02101D20 + i).toString(16).padStart(2, '0') + ' ';
  if ((i & 15) === 15) { console.log('  ' + row); row = ''; }
}
