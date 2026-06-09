// Find where ARM7 falls into the zero region. We capture the LAST
// non-zero-region PC before each entry into the zero region — that's
// the branch/call that sent ARM7 off the rails.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

for (let i = 0; i < 50; i++) emu.runFrame();

const ZERO_LO = 0x037fade8, ZERO_HI = 0x037fb000;
const lastBeforeZero: Array<{ pc: number; lr: number; r0: number; r1: number }> = [];
let inZero = false;

const orig7 = emu.cpu7.step.bind(emu.cpu7);
let lastPc = 0;
emu.cpu7.step = () => {
  const pc = emu.cpu7.state.r[15] & ~3;
  const isZ = pc >= ZERO_LO && pc < ZERO_HI;
  if (isZ && !inZero) {
    lastBeforeZero.push({
      pc: lastPc,
      lr: emu.cpu7.state.r[14],
      r0: emu.cpu7.state.r[0],
      r1: emu.cpu7.state.r[1],
    });
  }
  inZero = isZ;
  lastPc = pc;
  return orig7();
};

for (let i = 0; i < 5; i++) emu.runFrame();

console.log(`Times ARM7 fell into the zero region: ${lastBeforeZero.length}`);
for (let i = 0; i < Math.min(5, lastBeforeZero.length); i++) {
  const e = lastBeforeZero[i];
  console.log(`  #${i}  last-PC=0x${e.pc.toString(16).padStart(8, '0')}  LR=0x${e.lr.toString(16)}  R0=0x${e.r0.toString(16)}  R1=0x${e.r1.toString(16)}`);
  const w = emu.bus7.read32(e.pc);
  console.log(`        insn at last-PC: 0x${w.toString(16).padStart(8, '0')}`);
}
