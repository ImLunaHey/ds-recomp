// Dump and disassemble ARM7's hot loop in Pokemon Platinum.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';
import { disasmArm } from '../cpu/disasm';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

for (let i = 0; i < 5; i++) emu.runFrame();

const start = 0x02380120;
const end   = 0x02380180;
console.log(`ARM7 disasm 0x${start.toString(16)}..0x${end.toString(16)}:`);
for (let addr = start; addr < end; addr += 4) {
  const w = emu.bus7.read32(addr);
  console.log(`  0x${addr.toString(16)}  ${w.toString(16).padStart(8, '0')}  ${disasmArm(addr, w)}`);
}

// Also peek at the actual ARM7 binary header info
const header = emu.header!;
console.log(`\nARM7 RAM addr: 0x${header.arm7RamAddr.toString(16)}`);
console.log(`ARM7 ROM offset: 0x${header.arm7RomOffset.toString(16)}`);
console.log(`ARM7 size: 0x${header.arm7Size.toString(16)}`);
console.log(`ARM7 entry: 0x${header.arm7EntryAddr.toString(16)}`);

// Sample first 64 bytes of the ARM7 binary
console.log('\nFirst 32 bytes of ARM7 binary (at arm7RamAddr):');
let row = '';
for (let i = 0; i < 32; i++) {
  row += emu.bus7.read8(header.arm7RamAddr + i).toString(16).padStart(2, '0') + ' ';
}
console.log('  ' + row);
