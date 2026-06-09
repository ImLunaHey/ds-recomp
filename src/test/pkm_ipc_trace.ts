// Trace every IPC SYNC + IPC FIFO write on both CPUs. Find out what
// (if anything) the post-WRAMCNT-fix Pokemon Platinum is doing on the
// IPC channels.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

// Skip past the very early boot.
for (let i = 0; i < 10; i++) emu.runFrame();

const wrSync9: Array<{ f: number; v: number; pc: number }> = [];
const wrSync7: Array<{ f: number; v: number; pc: number }> = [];
const wrFifo9: Array<{ f: number; v: number; pc: number }> = [];
const wrFifo7: Array<{ f: number; v: number; pc: number }> = [];

const w16o9 = emu.io9.write16.bind(emu.io9);
const w16o7 = emu.io7.write16.bind(emu.io7);
const w32o9 = emu.io9.write32.bind(emu.io9);
const w32o7 = emu.io7.write32.bind(emu.io7);

let frame = 0;
emu.io9.write16 = (a, v) => {
  if ((a & 0x0FFFFFFF) === 0x04000180) wrSync9.push({ f: frame, v, pc: emu.cpu9.state.r[15] });
  return w16o9(a, v);
};
emu.io7.write16 = (a, v) => {
  if ((a & 0x0FFFFFFF) === 0x04000180) wrSync7.push({ f: frame, v, pc: emu.cpu7.state.r[15] });
  return w16o7(a, v);
};
emu.io9.write32 = (a, v) => {
  if ((a & 0x0FFFFFFC) === 0x04000188) wrFifo9.push({ f: frame, v, pc: emu.cpu9.state.r[15] });
  return w32o9(a, v);
};
emu.io7.write32 = (a, v) => {
  if ((a & 0x0FFFFFFC) === 0x04000188) wrFifo7.push({ f: frame, v, pc: emu.cpu7.state.r[15] });
  return w32o7(a, v);
};

for (let i = 0; i < 30; i++) { frame = i + 10; emu.runFrame(); }

console.log(`ARM9 IPCSYNC writes: ${wrSync9.length}`);
console.log(`ARM7 IPCSYNC writes: ${wrSync7.length}`);
console.log(`ARM9 IPCFIFO writes: ${wrFifo9.length}`);
console.log(`ARM7 IPCFIFO writes: ${wrFifo7.length}`);

console.log(`\nFirst 10 ARM9 IPCSYNC writes:`);
for (const w of wrSync9.slice(0, 10)) console.log(`  f${w.f}: v=0x${w.v.toString(16)} pc=0x${w.pc.toString(16)}`);
console.log(`\nFirst 5 ARM7 IPCSYNC writes:`);
for (const w of wrSync7.slice(0, 5)) console.log(`  f${w.f}: v=0x${w.v.toString(16)} pc=0x${w.pc.toString(16)}`);
console.log(`\nFirst 5 ARM9 IPCFIFO writes:`);
for (const w of wrFifo9.slice(0, 5)) console.log(`  f${w.f}: v=0x${w.v.toString(16)} pc=0x${w.pc.toString(16)}`);
console.log(`\nFirst 5 ARM7 IPCFIFO writes:`);
for (const w of wrFifo7.slice(0, 5)) console.log(`  f${w.f}: v=0x${w.v.toString(16)} pc=0x${w.pc.toString(16)}`);
