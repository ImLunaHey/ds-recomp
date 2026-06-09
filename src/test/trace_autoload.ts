// Find the source address the boot autoload reads from. The boot's
// memcpy loop is at 0x02000A50 (LDR R7, [R3], #+4 — load source word
// then increment R3). We intercept every ARM9 instruction and, when
// PC == 0x02000A50, record R3's value (the source address). The
// resulting list of source addresses tells us exactly where in the
// binary the boot reads from.

import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const sources: number[] = [];
let lastR4: number | null = null;
const origStep = emu.cpu9.step.bind(emu.cpu9);
emu.cpu9.step = () => {
  // Decode address = r[15] - prefetchOff for ARM. We just compare PC to
  // the decode address of the LDR.
  const decode = emu.cpu9.state.r[15] & ~3;
  if (decode === 0x02000A50) {
    sources.push(emu.cpu9.state.r[3]);
    lastR4 = emu.cpu9.state.r[4];
  }
  return origStep();
};

// Run enough frames for the autoload to finish.
for (let i = 0; i < 10; i++) emu.runFrame();

console.log(`memcpy LDR fired ${sources.length} times`);
if (sources.length > 0) {
  console.log(`first source addr:  0x${sources[0].toString(16)}`);
  console.log(`last source addr:   0x${sources[sources.length - 1].toString(16)}`);
  console.log(`source span:        0x${(sources[sources.length - 1] - sources[0] + 4).toString(16)} bytes`);
  console.log(`last dest R4:       0x${lastR4!.toString(16)}`);

  // Sample first 8 bytes at the source start.
  const start = sources[0] >>> 0;
  let bytes = '';
  for (let i = 0; i < 16; i++) {
    bytes += emu.bus9.read8(start + i).toString(16).padStart(2, '0') + ' ';
  }
  console.log(`first 16 bytes at 0x${start.toString(16)}: ${bytes}`);

  // Sample first 8 bytes at end - 16.
  const tail = (sources[sources.length - 1] - 12) >>> 0;
  bytes = '';
  for (let i = 0; i < 16; i++) {
    bytes += emu.bus9.read8(tail + i).toString(16).padStart(2, '0') + ' ';
  }
  console.log(`last 16 bytes at 0x${tail.toString(16)}: ${bytes}`);
}
