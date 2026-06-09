// Check the MOSAIC register evolution + OAM mosaic-bit per frame in
// the obj_mosaic test ROM.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/test_obj_mosaic.nds');
const emu = new Emulator();
emu.loadRom(rom);

let last = '';
for (let f = 0; f < 240; f++) {
  emu.runFrame();
  // mosaic + sprite 0's mosaic bit
  const m = emu.ppu.mosaicA;
  const oam = emu.mem.oam;
  const attr0 = oam[0] | (oam[1] << 8);
  const sprMos = (attr0 >> 12) & 1;
  const state = `M=0x${m.toString(16).padStart(4, '0')} (objH=${((m >> 8) & 0xF) + 1} objV=${((m >> 12) & 0xF) + 1}) spr0.mosaic=${sprMos} spr0.shape=${(attr0 >> 14) & 3} spr0.Y=${attr0 & 0xFF}`;
  if (state !== last) {
    console.log(`f${String(f).padStart(3)}: ${state}`);
    last = state;
  }
}
