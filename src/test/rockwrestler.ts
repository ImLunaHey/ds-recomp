// Sample ARM9 PC many times per frame to see what code is actually running.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';
import { disasmArm } from '../cpu/disasm';

const rom = readFileSync('public/rockwrestler.nds');
const emu = new Emulator();
emu.loadRom(rom);

const pcHistogram = new Map<number, number>();
let totalSamples = 0;
const origStep = emu.cpu9.step.bind(emu.cpu9);
emu.cpu9.step = () => {
  // Sample every 100th instruction to keep cost low.
  if ((totalSamples & 0xFF) === 0) {
    const pc = emu.cpu9.state.r[15] & ~3;
    pcHistogram.set(pc, (pcHistogram.get(pc) ?? 0) + 1);
  }
  totalSamples++;
  return origStep();
};

const frames = parseInt(process.argv[2] ?? '30', 10);
for (let i = 0; i < frames; i++) emu.runFrame();

console.log(`Total ARM9 steps: ${totalSamples.toLocaleString()}`);
console.log(`Distinct PCs sampled: ${pcHistogram.size}\n`);
console.log(`Top 15 PCs by sample count:`);
const sorted = [...pcHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [pc, n] of sorted) {
  const insn = emu.bus9.read32(pc);
  console.log(`  0x${pc.toString(16).padStart(8, '0')}  × ${String(n).padStart(5)}  ${insn.toString(16).padStart(8, '0')}  ${disasmArm(insn, pc)}`);
}
