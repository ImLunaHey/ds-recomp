// For each ARM7 autoload entry, compare source bytes (in RAM) with
// what ended up at the destination after boot. Mismatches show where
// the autoload broke down.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const arm7RamAddr = emu.header!.arm7RamAddr;
const arm7Size = emu.header!.arm7Size;
const binEnd = arm7RamAddr + arm7Size;

// Entries are at the very end of the binary (3 × 12 bytes = 36 bytes,
// preceded by a 20-byte module-params footer).
function readU32(addr: number): number { return emu.bus7.read32(addr); }

console.log(`Binary end RAM addr: 0x${binEnd.toString(16)}`);
console.log(`Last 64 bytes of binary (LE u32):`);
for (let off = binEnd - 64; off < binEnd; off += 4) {
  console.log(`  0x${off.toString(16)}  ${readU32(off).toString(16).padStart(8, '0')}`);
}

// Decode 3 entries at binEnd-36..binEnd.
console.log(`\nAutoload entries:`);
const entriesBase = binEnd - 36;
let cumCodeSize = 0;
const entries: Array<{ dst: number; codeSize: number; bssSize: number; srcRam: number }> = [];
for (let i = 0; i < 3; i++) {
  const base = entriesBase + i * 12;
  const dst = readU32(base);
  const codeSize = readU32(base + 4);
  const bssSize = readU32(base + 8);
  // Source data layout: walk from BACK of source block forward, i.e.
  // entry 0's source is FIRST, entry 1's second, etc. Source block
  // ends right at entriesBase, starts at entriesBase - sum(codeSize).
  entries.push({ dst, codeSize, bssSize, srcRam: 0 });
  console.log(`  entry ${i}: dst=0x${dst.toString(16)}  code=0x${codeSize.toString(16)}  bss=0x${bssSize.toString(16)}`);
  cumCodeSize += codeSize;
}

const sourceBlockEnd = entriesBase;
const sourceBlockStart = sourceBlockEnd - cumCodeSize;
console.log(`\nSource block: 0x${sourceBlockStart.toString(16)}..0x${sourceBlockEnd.toString(16)}`);
let off = sourceBlockStart;
for (const e of entries) { e.srcRam = off; off += e.codeSize; }

// For each entry, compare first 16 source bytes to first 16 dst bytes.
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  console.log(`\nEntry ${i}: srcRam=0x${e.srcRam.toString(16)} → dst=0x${e.dst.toString(16)}`);
  let srcRow = '  src: '; let dstRow = '  dst: ';
  for (let j = 0; j < 16; j++) {
    srcRow += emu.bus7.read8(e.srcRam + j).toString(16).padStart(2, '0') + ' ';
    dstRow += emu.bus7.read8(e.dst + j).toString(16).padStart(2, '0') + ' ';
  }
  console.log(srcRow);
  console.log(dstRow);

  // Sample at offset 0xadc0 (for entry 1 specifically, that's where ARM7 fell into zeros).
  if (i === 1) {
    let srcAdc = '  src@adc0: '; let dstAdc = '  dst@adc0: ';
    for (let j = 0; j < 16; j++) {
      srcAdc += emu.bus7.read8(e.srcRam + 0xadc0 + j).toString(16).padStart(2, '0') + ' ';
      dstAdc += emu.bus7.read8(e.dst + 0xadc0 + j).toString(16).padStart(2, '0') + ' ';
    }
    console.log(srcAdc);
    console.log(dstAdc);
  }
}

// Now run for 30 frames so ARM7 boots and the autoload completes.
for (let i = 0; i < 30; i++) emu.runFrame();

console.log(`\n--- After 30 frames ---`);
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  console.log(`\nEntry ${i}: dst=0x${e.dst.toString(16)}`);
  if (i === 1) {
    let dstAdc = '  dst@adc0: ';
    for (let j = 0; j < 16; j++) dstAdc += emu.bus7.read8(e.dst + 0xadc0 + j).toString(16).padStart(2, '0') + ' ';
    console.log(dstAdc);
  }
  let dstRow = '  dst[0..16]: ';
  for (let j = 0; j < 16; j++) dstRow += emu.bus7.read8(e.dst + j).toString(16).padStart(2, '0') + ' ';
  console.log(dstRow);
}
