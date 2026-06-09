// Dump the failure screen for a specific sub-test.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';
const KEY_A = 1, KEY_DOWN = 1 << 7;
const cat = parseInt(process.argv[2] ?? '3', 10);
const sub = parseInt(process.argv[3] ?? '2', 10);
const rom = readFileSync('public/rockwrestler.nds');
const emu = new Emulator();
emu.loadRom(rom);
for (let i = 0; i < 30; i++) emu.runFrame();
function press(bit: number, hold = 1, release = 4) {
  emu.io9.keyinput &= ~bit; emu.io7.keyinput &= ~bit;
  for (let i = 0; i < hold; i++) emu.runFrame();
  emu.io9.keyinput |= bit; emu.io7.keyinput |= bit;
  for (let i = 0; i < release; i++) emu.runFrame();
}
for (let n = 0; n < cat; n++) press(KEY_DOWN, 1, 4);
press(KEY_A, 1, 4);
for (let n = 0; n < sub; n++) press(KEY_DOWN, 1, 4);
press(KEY_A, 1, 60);
for (let f = 0; f < 1200; f++) emu.runFrame();

const vram = emu.mem.vram;
for (let col = 0; col < 10; col++) {
  console.log(`tile ${col}:`);
  for (let dy = 0; dy < 8; dy++) {
    let row = '  ';
    for (let dx = 0; dx < 8; dx++) {
      const x = col * 8 + dx, y = dy;
      const off = (y * 256 + x) * 2;
      const c = (vram[off] | (vram[off + 1] << 8)) & 0x7FFF;
      switch (c) {
        case 0x0000: row += '#'; break;
        case 0x294A: row += '+'; break;
        case 0x56B5: row += '.'; break;
        case 0x7FFF: row += ' '; break;
        default:     row += '?'; break;
      }
    }
    console.log(row);
  }
}
