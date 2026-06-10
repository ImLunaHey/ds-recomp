// Test if extending thunk to clear bit 0x200 helps NSMB advance state
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('/Users/luna/code/imlunahey/ds-recomp/public/New Super Mario Bros.nds');
const emu = new Emulator();
emu.loadRom(rom);

const ram = emu.mem.mainRam;

// Run frames, after each one, patch the thunk so it ALSO clears bit 0x200 on the handle.
// Specifically write thunk body to do:
//   LDR R1, [R0, #0x1C]    e5901_01c   = e5901_01c
//   BIC R1, R1, #0x200     e3c11_c02
//   STR R1, [R0, #0x1C]    e5801_01c
//   MOV R0, #6              e3a00006
//   BX LR                   e12fff1e
// But we need to NOT use R0 as the in-out as the handle, since we use it for return.
// Actually save: store +0x1C clearing 0x200, THEN MOV R0,#6.

// First let's just step a few frames natively to see if our hypothesis is even plausible.
// Manually clear the bit in mainRam after each FS dispatcher run.
for (let i = 0; i < 200; i++) {
  emu.runFrame();
  // Forcibly clear bit 0x200 of state at 0x02096114+0x1C
  const off = (0x02096114 + 0x1C) & 0x3FFFFF;
  let v = ram[off] | (ram[off+1]<<8) | (ram[off+2]<<16) | (ram[off+3]<<24);
  v &= ~0x200;
  ram[off] = v & 0xFF;
  ram[off+1] = (v >> 8) & 0xFF;
  ram[off+2] = (v >> 16) & 0xFF;
  ram[off+3] = (v >> 24) & 0xFF;
}

// Check the state
let vramNonZero = 0;
for (let j = 0; j < emu.mem.vram.length; j++) if (emu.mem.vram[j] !== 0) vramNonZero++;
const colors = new Set<number>();
for (let i = 0; i < emu.ppu.fbA.length; i += 4) {
  const c = (emu.ppu.fbA[i] << 16) | (emu.ppu.fbA[i+1] << 8) | emu.ppu.fbA[i+2];
  colors.add(c);
}
const r = (addr: number) => {
  const off = addr & 0x3FFFFF;
  return (ram[off] | (ram[off+1]<<8) | (ram[off+2]<<16) | (ram[off+3]<<24)) >>> 0;
};
console.log(`After 200 frames + manual bit-clear:`);
console.log(`VRAM non-zero: ${vramNonZero}`);
console.log(`fbA colors: ${colors.size}`);
console.log(`Handle state +0x1C: 0x${r(0x02096114 + 0x1C).toString(16)}`);
console.log(`Main task ctrl +0x114: 0x${r(0x020963F4).toString(16)}`);
console.log(`ARM9 PC: 0x${emu.cpu9.state.r[15].toString(16)}`);
