// Smoke-test menu navigation by injecting key events.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const KEY_DOWN  = 1 << 7;
const KEY_A     = 1 << 0;

const rom = readFileSync('public/rockwrestler.nds');
const emu = new Emulator();
emu.loadRom(rom);

// Let menu settle.
for (let i = 0; i < 30; i++) emu.runFrame();

function press(bit: number, holdFrames: number, releaseFrames: number): void {
  emu.io9.keyinput &= ~bit;
  emu.io7.keyinput &= ~bit;
  for (let i = 0; i < holdFrames; i++) emu.runFrame();
  emu.io9.keyinput |= bit;
  emu.io7.keyinput |= bit;
  for (let i = 0; i < releaseFrames; i++) emu.runFrame();
}

const FRAMES_BEFORE = emu.ppu.frameCount;
console.log(`Before nav: ARM9 PC=0x${emu.cpu9.state.r[15].toString(16)}`);

// Press DOWN twice to move cursor down.
press(KEY_DOWN, 1, 3);
press(KEY_DOWN, 1, 3);
console.log(`After 2× DOWN: ARM9 PC=0x${emu.cpu9.state.r[15].toString(16)}`);

// Press A to enter submenu.
press(KEY_A, 1, 5);
console.log(`After A: ARM9 PC=0x${emu.cpu9.state.r[15].toString(16)}`);

// Look at VRAM around the menu title area. The title should change.
const vram = emu.mem.vram;
// Decode the title row (row 0, columns 3..14): grab the 8x1 strip at
// (3*8, 0)..(14*8+7, 0) and count distinct pixel values per 8-px column.
// We just want to see whether ANY change occurred.
let nonGreyTopRow = 0;
for (let x = 0; x < 256; x++) {
  const c = vram[x * 2] | (vram[x * 2 + 1] << 8);
  if (c !== 0x56B5 && c !== 0) nonGreyTopRow++;
}
console.log(`Top-row non-grey pixel count: ${nonGreyTopRow}`);
console.log(`Title bytes [16..32]: ${[...vram.subarray(16, 32)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
console.log(`Total frames simulated: ${emu.ppu.frameCount - FRAMES_BEFORE}`);
