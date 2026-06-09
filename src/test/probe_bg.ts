// Read each test ROM's BG configuration after boot.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const romName = process.argv[2] ?? 'test_obj_mosaic.nds';
const rom = readFileSync(`public/${romName}`);
const emu = new Emulator();
emu.loadRom(rom);
for (let i = 0; i < 60; i++) emu.runFrame();

const ppu = emu.ppu;
console.log(`${romName}`);
console.log(`DISPCNT_A = 0x${ppu.dispcntA.toString(16)} (mode=${ppu.dispcntA & 7}, BG enables 8..11 = ${(ppu.dispcntA >> 8) & 0xF}, OBJ=${(ppu.dispcntA >> 12) & 1})`);
console.log(`DISPCNT_B = 0x${ppu.dispcntB.toString(16)}`);
console.log();
for (let bg = 0; bg < 4; bg++) {
  console.log(`Engine A BG${bg}CNT = 0x${ppu.bgCntA[bg].toString(16).padStart(4, '0')}  hofs=0x${ppu.bgHofsA[bg].toString(16)}  vofs=0x${ppu.bgVofsA[bg].toString(16)}`);
}
console.log();
for (let bg = 0; bg < 4; bg++) {
  console.log(`Engine B BG${bg}CNT = 0x${ppu.bgCntB[bg].toString(16).padStart(4, '0')}`);
}
console.log();
for (let i = 0; i < 9; i++) {
  const name = 'ABCDEFGHI'[i];
  console.log(`VRAMCNT_${name} = 0x${ppu.vramcnt[i].toString(16).padStart(2, '0')}`);
}

// Sample first 16 OAM entries.
console.log(`\nFirst 8 OAM (engine A) entries (8 bytes each):`);
for (let s = 0; s < 8; s++) {
  const base = s * 8;
  const oam = emu.mem.oam;
  const attr0 = oam[base] | (oam[base + 1] << 8);
  const attr1 = oam[base + 2] | (oam[base + 3] << 8);
  const attr2 = oam[base + 4] | (oam[base + 5] << 8);
  console.log(`  sprite ${s}: attr0=0x${attr0.toString(16).padStart(4, '0')} attr1=0x${attr1.toString(16).padStart(4, '0')} attr2=0x${attr2.toString(16).padStart(4, '0')}`);
}
