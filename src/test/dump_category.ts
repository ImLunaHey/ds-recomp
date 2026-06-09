// Run a specific RockWrestler menu category and dump the top screen
// as ASCII art so we can see what's on it.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const KEY_A = 1, KEY_DOWN = 1 << 7;
const category = parseInt(process.argv[2] ?? '4', 10);

const rom = readFileSync('public/rockwrestler.nds');
const emu = new Emulator();
emu.loadRom(rom);
for (let i = 0; i < 30; i++) emu.runFrame();

function press(bit: number, hold = 1, release = 4): void {
  emu.io9.keyinput &= ~bit;
  emu.io7.keyinput &= ~bit;
  for (let i = 0; i < hold; i++) emu.runFrame();
  emu.io9.keyinput |= bit;
  emu.io7.keyinput |= bit;
  for (let i = 0; i < release; i++) emu.runFrame();
}

// Navigate to row `category` and press A twice.
for (let n = 0; n < category; n++) press(KEY_DOWN, 1, 4);
press(KEY_A, 1, 4);
press(KEY_A, 1, 60);

// Wait a long time so the test finishes.
for (let f = 0; f < 1200; f++) emu.runFrame();

const vram = emu.mem.vram;
const W = 256, H = 192;
const RAMP = ' .:-=+*#%@';
let out = '';
for (let cy = 0; cy < 24; cy++) {
  for (let cx = 0; cx < 64; cx++) {
    let sum = 0, n = 0;
    for (let dy = 0; dy < 8; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        const x = cx * 4 + dx;
        const y = cy * 8 + dy;
        const off = (y * W + x) * 2;
        const c = (vram[off] | (vram[off + 1] << 8)) & 0x7FFF;
        const r = (c >> 0) & 0x1F, g = (c >> 5) & 0x1F, b = (c >> 10) & 0x1F;
        sum += r + g + b;
        n++;
      }
    }
    const avg = sum / n;
    const idx = Math.min(RAMP.length - 1, Math.max(0, ((avg / 93) * (RAMP.length - 1)) | 0));
    out += RAMP[idx];
  }
  out += '\n';
}
console.log(out);
console.log(`ARM9 PC: 0x${emu.cpu9.state.r[15].toString(16)}  ARM7 PC: 0x${emu.cpu7.state.r[15].toString(16)}`);
console.log(`IPC SYNC s9=${emu.ipc.sync9Out} s7=${emu.ipc.sync7Out}`);
console.log(`IPC FIFO 9→7: ${emu.ipc.q9to7.size}  7→9: ${emu.ipc.q7to9.size}`);
