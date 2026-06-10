// Quick verification that SM64DS gets past the early IPCSYNC handshake.
// Not a vitest suite (the ROM isn't bundled into the repo); run by hand:
//   cp 'public/Super Mario 64 DS.nds' /tmp/sm64ds.nds
//   npx tsx src/test/sm64ds_boot_check.ts

import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('/tmp/sm64ds.nds');
const emu = new Emulator();
emu.loadRom(rom);

for (let i = 0; i < 60; i++) emu.runFrame();

console.log(`After 60 frames:`);
console.log(`  pc9        = 0x${emu.cpu9.state.r[15].toString(16)}`);
console.log(`  pc7        = 0x${emu.cpu7.state.r[15].toString(16)}`);
console.log(`  s9 / s7    = ${emu.ipc.sync9Out} / ${emu.ipc.sync7Out}`);
console.log(`  DISPCNT_A  = 0x${emu.ppu.dispcntA.toString(16)}`);
console.log(`  IE9 / IF9 / IME9 = 0x${emu.irq9.ie.toString(16)} / 0x${emu.irq9.if_.toString(16)} / ${emu.irq9.ime}`);
console.log(`  IE7 / IF7 / IME7 = 0x${emu.irq7.ie.toString(16)} / 0x${emu.irq7.if_.toString(16)} / ${emu.irq7.ime}`);

const advanced = emu.ppu.dispcntA !== 0 && emu.irq9.ime;
console.log();
console.log(advanced
  ? 'PASS: SM64DS advanced past the IPCSYNC handshake.'
  : 'FAIL: still stuck in the early handshake.');
process.exit(advanced ? 0 : 1);
