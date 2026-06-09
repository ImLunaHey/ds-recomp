// Dump disassembly around the ARM7 stuck PC + count distinct IPCSYNC
// values each CPU has ever written.

import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';
import { disasmArm } from '../cpu/disasm';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const sync9Vals = new Set<number>();
const sync7Vals = new Set<number>();

const ipcOrigWrite = emu.ipc.writeSync.bind(emu.ipc);
emu.ipc.writeSync = (isArm9: boolean, v: number) => {
  const out = (v >>> 8) & 0x0F;
  (isArm9 ? sync9Vals : sync7Vals).add(out);
  return ipcOrigWrite(isArm9, v);
};

for (let i = 0; i < 30; i++) emu.runFrame();

console.log(`ARM7 stuck PC: 0x${emu.cpu7.state.r[15].toString(16)}`);
console.log(`ARM9 stuck PC: 0x${emu.cpu9.state.r[15].toString(16)}`);
console.log();

const dump = (label: string, pc: number, bus: { read32(a: number): number }) => {
  console.log(`=== ${label} disasm window (±64 around PC=0x${pc.toString(16)}) ===`);
  const start = (pc - 64) & ~3;
  for (let off = 0; off < 128; off += 4) {
    const a = (start + off) >>> 0;
    const insn = bus.read32(a);
    const mark = a === (pc & ~3) ? ' <—' : '';
    console.log(`  0x${a.toString(16).padStart(8, '0')}  ${insn.toString(16).padStart(8, '0')}  ${disasmArm(insn, a)}${mark}`);
  }
  console.log();
};

dump('ARM7', emu.cpu7.state.r[15], emu.bus7);

console.log(`Distinct OUT-nibbles seen — ARM9 wrote ${[...sync9Vals].sort().join(',')}; ARM7 wrote ${[...sync7Vals].sort().join(',')}`);

console.log(`\nARM7 regs:`);
for (let i = 0; i < 16; i++) {
  process.stdout.write(`  r${String(i).padStart(2, '0')}=0x${emu.cpu7.state.r[i].toString(16).padStart(8, '0')}`);
  if (i % 4 === 3) process.stdout.write('\n');
}
console.log(`  cpsr=0x${emu.cpu7.state.cpsr.toString(16)}  thumb=${emu.cpu7.state.inThumb()}`);
