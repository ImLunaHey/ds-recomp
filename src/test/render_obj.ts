// ASCII dump of test_obj_mosaic top screen.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const romName = process.argv[2] ?? 'test_obj_mosaic.nds';
const rom = readFileSync(`public/${romName}`);
const emu = new Emulator();
emu.loadRom(rom);
for (let i = 0; i < 120; i++) emu.runFrame();

const fb = emu.ppu.fbA;
const W = 256, H = 192;
const RAMP = ' .:-=+*#%@';
let out = '';
for (let cy = 0; cy < 48; cy++) {
  for (let cx = 0; cx < 128; cx++) {
    let sum = 0, n = 0;
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const x = cx * 2 + dx;
        const y = cy * 4 + dy;
        const off = (y * W + x) * 4;
        sum += fb[off] + fb[off + 1] + fb[off + 2];
        n++;
      }
    }
    const avg = sum / (n * 3);
    const idx = Math.min(RAMP.length - 1, Math.max(0, ((avg / 255) * (RAMP.length - 1)) | 0));
    out += RAMP[idx];
  }
  out += '\n';
}
console.log(out);

let nonBg = 0;
for (let i = 0; i < W * H; i++) {
  const off = i * 4;
  if (fb[off] !== fb[off + 1] || fb[off] !== fb[off + 2]) nonBg++;
}
console.log(`non-monochrome pixels: ${nonBg}`);
