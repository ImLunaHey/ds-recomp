// Track every ARM7 write during the first 2 frames + report the
// range of addresses written from each PC.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const writesByPc = new Map<number, { count: number; minAddr: number; maxAddr: number }>();
const w32 = emu.bus7.write32.bind(emu.bus7);
emu.bus7.write32 = (addr, v) => {
  const pc = emu.cpu7.state.r[15] & ~3;
  let rec = writesByPc.get(pc);
  if (!rec) { rec = { count: 0, minAddr: addr, maxAddr: addr }; writesByPc.set(pc, rec); }
  rec.count++;
  if (addr < rec.minAddr) rec.minAddr = addr;
  if (addr > rec.maxAddr) rec.maxAddr = addr;
  w32(addr, v);
};

for (let i = 0; i < 2; i++) emu.runFrame();

const sorted = [...writesByPc.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`Top ARM7 store sites (by count):`);
for (const [pc, r] of sorted.slice(0, 10)) {
  console.log(`  PC=0x${pc.toString(16)} × ${r.count.toLocaleString().padStart(7)}  range=0x${r.minAddr.toString(16)}..0x${r.maxAddr.toString(16)}`);
}
