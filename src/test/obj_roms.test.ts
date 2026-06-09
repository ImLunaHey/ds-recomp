import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const ROMS = [
  'public/test_obj_mosaic.nds',
  'public/test_obj_prio.nds',
  'public/test_obj_mos_fuzz.nds',
] as const;

function bootAndCountSpritePixels(romPath: string, frames: number): {
  spritePixels: number;
  dispcntA: number;
  vramNonZero: number;
} {
  const rom = readFileSync(romPath);
  const emu = new Emulator();
  emu.loadRom(rom);
  for (let i = 0; i < frames; i++) emu.runFrame();

  // Count colored (non-monochrome) pixels in the engine A framebuffer
  // as a proxy for "sprites/BGs got rendered."
  const fb = emu.ppu.fbA;
  let colored = 0;
  for (let i = 0; i < fb.length; i += 4) {
    if (fb[i] !== fb[i + 1] || fb[i] !== fb[i + 2]) colored++;
  }

  let vramNonZero = 0;
  for (let i = 0; i < emu.mem.vram.length; i++) {
    if (emu.mem.vram[i] !== 0) vramNonZero++;
  }

  return { spritePixels: colored, dispcntA: emu.ppu.dispcntA, vramNonZero };
}

for (const path of ROMS) {
  const have = existsSync(path);
  describe.skipIf(!have)(`${path.split('/').pop()}`, () => {
    it('boots through 120 frames into BG mode 5 with rendered sprites', { timeout: 30000 }, () => {
      const r = bootAndCountSpritePixels(path, 120);
      expect(r.dispcntA & 0x7).toBe(5);                  // mode 5
      expect((r.dispcntA >>> 16) & 0x3).toBe(1);          // graphics display
      expect((r.dispcntA & 0x1000)).not.toBe(0);          // OBJ enabled
      expect(r.vramNonZero).toBeGreaterThan(1000);        // game wrote into VRAM
      expect(r.spritePixels).toBeGreaterThan(100);        // engine A composed colored output
    });
  });
}
