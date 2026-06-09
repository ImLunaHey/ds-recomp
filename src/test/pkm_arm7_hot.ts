// Find ARM7's HOTTEST PCs (not "most distinct PCs"). What's the
// tight inner loop ARM7 is grinding on?
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

// Skip past initial boot.
for (let i = 0; i < 50; i++) emu.runFrame();

const arm7Pcs = new Map<number, number>();
const arm7Stack: number[] = [];
const orig7 = emu.cpu7.step.bind(emu.cpu7);
emu.cpu7.step = () => {
  const pc = emu.cpu7.state.r[15] & ~3;
  arm7Pcs.set(pc, (arm7Pcs.get(pc) ?? 0) + 1);
  // Also note R14 (LR) for some samples to identify caller.
  if (arm7Stack.length < 10) arm7Stack.push(emu.cpu7.state.r[14]);
  return orig7();
};

for (let i = 0; i < 10; i++) emu.runFrame();

const sorted = [...arm7Pcs.entries()].sort((a, b) => b[1] - a[1]);
console.log(`Top 20 ARM7 PCs over frames 50-60:`);
for (const [pc, n] of sorted.slice(0, 20)) {
  const w = emu.bus7.read32(pc);
  console.log(`  0x${pc.toString(16).padStart(8, '0')} × ${n.toLocaleString().padStart(10)}  insn=0x${w.toString(16).padStart(8, '0')}`);
}

// Dump 32 instructions around the hottest PC.
const hot = sorted[0][0];
const start = Math.max(0x037f8000, hot - 64);
console.log(`\nDisasm 32 insns around hot PC 0x${hot.toString(16)}:`);
for (let a = start; a < start + 0x80; a += 4) {
  const w = emu.bus7.read32(a);
  const marker = (a === hot) ? ' <<<' : '';
  console.log(`  0x${a.toString(16)}  ${w.toString(16).padStart(8, '0')}${marker}`);
}

console.log(`\nFinal ARM7 state: PC=0x${emu.cpu7.state.r[15].toString(16)} LR=0x${emu.cpu7.state.r[14].toString(16)} SP=0x${emu.cpu7.state.r[13].toString(16)}`);
