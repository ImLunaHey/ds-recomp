// Find runs of 0x00ff00ff in the ARM9 binary to locate the source data.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const PATTERN = 0x00ff00ff;
const runs: Array<{ start: number; length: number }> = [];
let runStart = -1;
const arm9End = 0x02000000 + emu.header!.arm9Size;
for (let addr = 0x02000000; addr < arm9End; addr += 4) {
  const v = emu.bus9.read32(addr);
  if (v === PATTERN) {
    if (runStart < 0) runStart = addr;
  } else {
    if (runStart >= 0 && (addr - runStart) >= 16) {
      runs.push({ start: runStart, length: addr - runStart });
    }
    runStart = -1;
  }
}
if (runStart >= 0) runs.push({ start: runStart, length: arm9End - runStart });

console.log(`Runs of 0x00ff00ff (>= 16 bytes) in ARM9 binary:`);
for (const r of runs) {
  console.log(`  0x${r.start.toString(16).padStart(8, '0')}  length=0x${r.length.toString(16)} (${r.length} bytes)`);
}
console.log(`Total runs: ${runs.length}, total bytes: ${runs.reduce((s, r) => s + r.length, 0)}`);
