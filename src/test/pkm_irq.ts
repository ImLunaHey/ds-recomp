// Diagnose Pokemon's IRQ handler setup on both CPUs after 60 frames.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);
for (let i = 0; i < 60; i++) emu.runFrame();

console.log(`ARM9 user IRQ handler ptr @ DTCM end-4: 0x${emu.bus9.read32(0x027FFFFC).toString(16)}`);
console.log(`ARM7 user IRQ handler ptr @ 0x03FFFFFC: 0x${emu.bus7.read32(0x03FFFFFC).toString(16)}`);
console.log();

// Did the VBlank IRQ ever fire on ARM7?
console.log(`IF7 = 0x${emu.irq7.if_.toString(16)} (bits set = pending IRQs)`);
console.log(`IE7 = 0x${emu.irq7.ie.toString(16)} (bits set = enabled)`);
console.log(`IME7 = ${emu.irq7.ime}`);
console.log(`ARM7 halted = ${emu.cpu7.state.halted}`);

// CPSR of ARM7
console.log(`ARM7 CPSR = 0x${emu.cpu7.state.cpsr.toString(16)} (I=${(emu.cpu7.state.cpsr >> 7) & 1}, T=${(emu.cpu7.state.cpsr >> 5) & 1}, mode=${emu.cpu7.state.cpsr & 0x1F})`);
console.log();

// Run a few more frames + trace whether ARM7 actually takes the IRQ.
let irqsTaken = 0;
const origTake = emu.cpu7.takeIrq.bind(emu.cpu7);
emu.cpu7.takeIrq = () => { irqsTaken++; return origTake(); };
for (let i = 0; i < 10; i++) emu.runFrame();
console.log(`ARM7 IRQs taken over 10 frames: ${irqsTaken}`);

// Sample handler ptr after more frames in case it was set later.
console.log(`After 70 frames, ARM7 user handler ptr: 0x${emu.bus7.read32(0x03FFFFFC).toString(16)}`);
