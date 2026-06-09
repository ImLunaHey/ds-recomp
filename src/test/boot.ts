// Headless boot probe. Loads the bundled Pokemon Platinum ROM, boots a
// few frames, and prints state — used for fast iteration on CPU/IO
// bugs without the browser.
//
// Usage: npx tsx src/test/boot.ts [frames]

import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const frames = parseInt(process.argv[2] ?? '5', 10);
const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');

const emu = new Emulator();
emu.loadRom(rom);

console.log(`title:   ${emu.header!.title}`);
console.log(`code:    ${emu.header!.gameCode}`);
console.log(`ARM9 entry: 0x${emu.header!.arm9EntryAddr.toString(16)}`);
console.log(`ARM7 entry: 0x${emu.header!.arm7EntryAddr.toString(16)}`);
console.log(`Copied: ARM9 ${emu.load!.arm9Bytes} bytes, ARM7 ${emu.load!.arm7Bytes} bytes`);
console.log();

let totalA9 = 0, totalA7 = 0;
for (let i = 0; i < frames; i++) {
  const t0 = performance.now();
  const r = emu.runFrame();
  const dt = performance.now() - t0;
  totalA9 += r.arm9;
  totalA7 += r.arm7;
  console.log(
    `frame ${String(i).padStart(3)} | ` +
    `a9=${String(r.arm9).padStart(7)} a7=${String(r.arm7).padStart(7)} | ` +
    `pc9=0x${emu.cpu9.state.r[15].toString(16).padStart(8, '0')} ` +
    `pc7=0x${emu.cpu7.state.r[15].toString(16).padStart(8, '0')} | ` +
    `halted9=${emu.cpu9.state.halted} halted7=${emu.cpu7.state.halted} | ` +
    `vcount=${emu.ppu.vcount} dispstat=0x${emu.ppu.dispstat.toString(16).padStart(4, '0')} | ` +
    `${dt.toFixed(1)}ms`
  );
}
console.log();
console.log(`total: a9=${totalA9.toLocaleString()} a7=${totalA7.toLocaleString()} frames=${emu.ppu.frameCount}`);
console.log(`IE9=0x${emu.irq9.ie.toString(16)} IF9=0x${emu.irq9.if_.toString(16)} IME9=${emu.irq9.ime}`);
console.log(`IE7=0x${emu.irq7.ie.toString(16)} IF7=0x${emu.irq7.if_.toString(16)} IME7=${emu.irq7.ime}`);
console.log(`DISPCNT_A=0x${emu.ppu.dispcntA.toString(16)} DISPCNT_B=0x${emu.ppu.dispcntB.toString(16)}`);
