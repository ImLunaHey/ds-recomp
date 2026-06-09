// Track Pokemon Platinum IPC SYNC + ARM9 PC progression.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

// Also track ARM9 IPCSYNC writes specifically — what values get written.
const ipcWrites: Array<{ frame: number; v: number }> = [];
const w16o = emu.io9.write16.bind(emu.io9);
emu.io9.write16 = (a, v) => {
  if ((a & 0x0FFFFFFF) === 0x04000180) ipcWrites.push({ frame: currentFrame, v });
  w16o(a, v);
};
let currentFrame = 0;
let lastState = '';
for (let i = 0; i < 60; i++) {
  currentFrame = i;
  emu.runFrame();
  const state = `s9=${emu.ipc.sync9Out} s7=${emu.ipc.sync7Out} ime9=${emu.irq9.ime?1:0} ime7=${emu.irq7.ime?1:0} dispcntA=0x${emu.ppu.dispcntA.toString(16)} h9=${emu.cpu9.state.halted?1:0} h7=${emu.cpu7.state.halted?1:0}`;
  if (state !== lastState) {
    console.log(`f${String(i).padStart(3)}: ${state}  pc9=0x${emu.cpu9.state.r[15].toString(16)} pc7=0x${emu.cpu7.state.r[15].toString(16)}`);
    lastState = state;
  }
}
console.log(`\nTotal IPC SYNC writes by ARM9: ${ipcWrites.length}`);
console.log(`First 5 writes:`);
for (const w of ipcWrites.slice(0, 5)) console.log(`  f${w.frame}: 0x${w.v.toString(16)}`);
console.log(`Last 5 writes:`);
for (const w of ipcWrites.slice(-5)) console.log(`  f${w.frame}: 0x${w.v.toString(16)}`);

console.log(`\nfinal DISPCNT_A=0x${emu.ppu.dispcntA.toString(16)}`);
console.log(`First VRAM write addr (tracked)?  Manually check.`);
const vram = emu.mem.vram;
let firstNonZero = -1;
for (let i = 0; i < emu.mem.vram.length; i++) if (vram[i] !== 0) { firstNonZero = i; break; }
console.log(`First non-zero VRAM byte: ${firstNonZero < 0 ? 'none' : '0x' + firstNonZero.toString(16)}`);
