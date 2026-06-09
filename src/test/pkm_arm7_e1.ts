// Track every ARM7 write to entry 1's dest range (0x037F8000+0xEC94)
// to see what code actually ran the autoload and where its writes ended up.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

const E1_LO = 0x037F8000, E1_HI = 0x037F8000 + 0xEC94;
const sourcePcs = new Map<number, number>();
const firstFew: Array<{ pc: number; addr: number; v: number }> = [];

const w32 = emu.bus7.write32.bind(emu.bus7);
emu.bus7.write32 = (addr, v) => {
  if (addr >= E1_LO && addr < E1_HI) {
    const pc = emu.cpu7.state.r[15] & ~3;
    sourcePcs.set(pc, (sourcePcs.get(pc) ?? 0) + 1);
    if (firstFew.length < 5) firstFew.push({ pc, addr, v });
  }
  w32(addr, v);
};

// Run only long enough for the autoload to (try to) complete.
for (let i = 0; i < 3; i++) emu.runFrame();

console.log(`Writes to entry-1 dest range 0x${E1_LO.toString(16)}..0x${E1_HI.toString(16)}:`);
console.log(`Total source PCs:`, sourcePcs.size);
console.log(`First 5 writes:`);
for (const w of firstFew) console.log(`  PC=0x${w.pc.toString(16)}  addr=0x${w.addr.toString(16)}  v=0x${w.v.toString(16)}`);

const top = [...sourcePcs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`Top source PCs by count:`);
for (const [pc, n] of top) console.log(`  PC=0x${pc.toString(16)} × ${n}`);

console.log(`\nFinal R1 at end: 0x${emu.cpu7.state.r[1].toString(16)}`);

// Also dump the actual content at 0x037F8000 after run.
console.log(`\nIWRAM[0x8000] = 0x${emu.bus7.read32(0x037F8000).toString(16)}`);
console.log(`IWRAM[0x8004] = 0x${emu.bus7.read32(0x037F8004).toString(16)}`);
console.log(`IWRAM[0x8100] = 0x${emu.bus7.read32(0x037F8100).toString(16)}`);
