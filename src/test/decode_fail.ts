// Read the FAIL message at the top of the screen by sampling the first
// tile-row from VRAM. Each char is 8x8 4-color (palette 0..3, font.bin).
// We just look for the "FAIL " prefix and then OCR each subsequent
// hex digit by counting lit pixels per tile vs known signatures.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const KEY_A = 1, KEY_DOWN = 1 << 7;
const category = parseInt(process.argv[2] ?? '4', 10);

const rom = readFileSync('public/rockwrestler.nds');
const emu = new Emulator();
emu.loadRom(rom);
for (let i = 0; i < 30; i++) emu.runFrame();

function press(bit: number, hold = 1, release = 4): void {
  emu.io9.keyinput &= ~bit; emu.io7.keyinput &= ~bit;
  for (let i = 0; i < hold; i++) emu.runFrame();
  emu.io9.keyinput |= bit;  emu.io7.keyinput |= bit;
  for (let i = 0; i < release; i++) emu.runFrame();
}

for (let n = 0; n < category; n++) press(KEY_DOWN, 1, 4);
press(KEY_A, 1, 4);
press(KEY_A, 1, 60);

// Find where ARM9 is when test "completes" — should be in the wait-B
// loop inside cpp_fail_test or after passing test.
for (let f = 0; f < 1200; f++) emu.runFrame();

const vram = emu.mem.vram;

// Dump each tile with 4 distinct symbols for the 4 palette entries
// (0x0000=black, 0x294A=dark grey, 0x56B5=light grey, 0x7FFF=white).
function symbolFor(c: number): string {
  switch (c & 0x7FFF) {
    case 0x0000: return '#';   // black — typical character ink
    case 0x294A: return '+';   // dark grey
    case 0x56B5: return '.';   // light grey — background
    case 0x7FFF: return ' ';   // white
    default:     return '?';
  }
}
console.log('Top-row tiles (row 0) with palette-based symbols:');
console.log('  # = black ink, + = dark grey, . = bg light grey, (space) = white');
for (let col = 0; col < 12; col++) {
  console.log(`  tile ${col}:`);
  for (let dy = 0; dy < 8; dy++) {
    let row = '    ';
    for (let dx = 0; dx < 8; dx++) {
      const x = col * 8 + dx, y = dy;
      const off = (y * 256 + x) * 2;
      const c = (vram[off] | (vram[off + 1] << 8));
      row += symbolFor(c);
    }
    console.log(row);
  }
}
