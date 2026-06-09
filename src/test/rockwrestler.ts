// Sample ARM9 PC many times per frame to see what code is actually running.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';
import { disasmArm } from '../cpu/disasm';

const rom = readFileSync('public/rockwrestler.nds');
const emu = new Emulator();
emu.loadRom(rom);

const frames = parseInt(process.argv[2] ?? '30', 10);
for (let i = 0; i < frames; i++) emu.runFrame();

// Check VRAM bank A for any non-zero content.
const vram = emu.mem.vram;
let firstNonZero = -1;
for (let i = 0; i < 256 * 192 * 2; i++) if (vram[i] !== 0) { firstNonZero = i; break; }
console.log(`First non-zero VRAM byte: ${firstNonZero < 0 ? 'none' : '0x' + firstNonZero.toString(16) + ' = 0x' + vram[firstNonZero].toString(16)}`);

// Sample a few pixels.
const px = (x: number, y: number) => {
  const off = (y * 256 + x) * 2;
  return '0x' + (vram[off] | (vram[off + 1] << 8)).toString(16).padStart(4, '0');
};
console.log(`Pixels: (0,0)=${px(0, 0)} (50,50)=${px(50, 50)} (100,100)=${px(100, 100)} (200,150)=${px(200, 150)}`);
console.log(`DISPCNT_A=0x${emu.ppu.dispcntA.toString(16)} VRAMCNT_A=0x${emu.ppu.vramcnt[0].toString(16)}`);
