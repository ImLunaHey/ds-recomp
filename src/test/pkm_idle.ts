// What are ARM9 + ARM7 doing in their idle loops?
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);
for (let i = 0; i < 60; i++) emu.runFrame();

const pc9 = emu.cpu9.state.r[15] & ~3;
const pc7 = emu.cpu7.state.r[15] & ~3;
console.log(`ARM9 PC=0x${pc9.toString(16)}`);
console.log(`ARM7 PC=0x${pc7.toString(16)}`);
console.log(`halted9=${emu.cpu9.state.halted} halted7=${emu.cpu7.state.halted}`);
console.log(`IF9=0x${emu.irq9.if_.toString(16)} IF7=0x${emu.irq7.if_.toString(16)}`);
console.log(`IE9=0x${emu.irq9.ie.toString(16)} IE7=0x${emu.irq7.ie.toString(16)}`);
console.log(`POSTFLG9=${emu.io9.postflg} POSTFLG7=${emu.io7.postflg}`);

console.log(`\nDisasm around ARM9 PC (wider window):`);
for (let a = pc9 - 64; a < pc9 + 64; a += 4) {
  const w = emu.bus9.read32(a);
  console.log(`  0x${a.toString(16)}  ${w.toString(16).padStart(8, '0')}${a === pc9 ? ' <<<' : ''}`);
}

console.log(`\nDisasm around ARM7 PC:`);
for (let a = pc7 - 16; a < pc7 + 32; a += 4) {
  const w = emu.bus7.read32(a);
  console.log(`  0x${a.toString(16)}  ${w.toString(16).padStart(8, '0')}${a === pc7 ? ' <<<' : ''}`);
}
