import { describe, it, expect } from 'vitest';
import { Emulator } from '../emulator';

// Pack three vertex shorthands.
function packXY(x: number, y: number): number {
  const lo = (Math.round(x * 4096) & 0xFFFF);
  const hi = (Math.round(y * 4096) & 0xFFFF) << 16;
  return (lo | hi) >>> 0;
}
function packZ(z: number): number { return (Math.round(z * 4096) & 0xFFFF); }

function buildSceneAndSwap(): Emulator {
  const emu = new Emulator();
  const gx = emu.ppu.gx;
  const cmd = (op: number, ...params: number[]): void => {
    gx.writeFifo(op);
    for (const p of params) gx.writeFifo(p);
  };
  cmd(0x10, 0);            // MTX_MODE = projection
  cmd(0x15);                // MTX_IDENTITY
  cmd(0x10, 1);             // MTX_MODE = position
  cmd(0x15);                // MTX_IDENTITY
  cmd(0x40, 0);             // BEGIN_VTXS = tri list
  cmd(0x20, 0x001F);        // COLOR = bright red
  cmd(0x23, packXY(-0.5, -0.5), packZ(0));
  cmd(0x23, packXY( 0.5, -0.5), packZ(0));
  cmd(0x23, packXY( 0.0,  0.5), packZ(0));
  cmd(0x41);                // END_VTXS
  cmd(0x50, 0);             // SWAP_BUFFERS
  return emu;
}

describe('GX: smoke triangle', () => {
  const emu = buildSceneAndSwap();
  const fb = emu.ppu.gx.fbFront;

  it('rasterizes a triangle into fbFront', () => {
    let drawn = 0;
    for (let i = 0; i < fb.length; i++) if ((fb[i] & 0x8000) !== 0) drawn++;
    expect(drawn).toBeGreaterThan(5000);
    expect(drawn).toBeLessThan(7000);
  });

  it('uses the COLOR-set red (0x1F) on every drawn pixel', () => {
    const colors = new Set<number>();
    for (let i = 0; i < fb.length; i++) {
      if ((fb[i] & 0x8000) !== 0) colors.add(fb[i] & 0x7FFF);
    }
    expect(colors.size).toBe(1);
    expect([...colors][0]).toBe(0x001F);
  });

  it('triangle is in the right screen region', () => {
    // Centroid of triangle in screen coords:
    //   v0 = (-0.5, -0.5) → screen (64, 144)
    //   v1 = ( 0.5, -0.5) → screen (192, 144)
    //   v2 = ( 0,    0.5) → screen (128, 48)
    // centroid ≈ (128, 112)
    const W = 256;
    let sumX = 0, sumY = 0, n = 0;
    for (let y = 0; y < 192; y++) {
      for (let x = 0; x < W; x++) {
        if ((fb[y * W + x] & 0x8000) !== 0) { sumX += x; sumY += y; n++; }
      }
    }
    expect(n).toBeGreaterThan(0);
    expect(Math.round(sumX / n)).toBeGreaterThan(110);
    expect(Math.round(sumX / n)).toBeLessThan(146);
    expect(Math.round(sumY / n)).toBeGreaterThan(95);
    expect(Math.round(sumY / n)).toBeLessThan(125);
  });
});

describe('GX: composite into engine A BG0 when DISPCNT bit 3 set', () => {
  it('engine A framebuffer shows the triangle red when 3D enabled', () => {
    const emu = buildSceneAndSwap();
    // Engine A: graphics mode 1, BG0 enabled, 3D enabled (bit 3).
    emu.ppu.dispcntA = (1 << 16) | (1 << 8) | (1 << 3);
    emu.ppu.bgCntA[0] = 0;          // priority 0
    // Backdrop palette[0] = white so red pixels stand out.
    emu.mem.pram[0] = 0xFF; emu.mem.pram[1] = 0x7F;
    // Run a frame so engine A renders.
    emu.runFrame();
    const fb = emu.ppu.fbA;
    let redCount = 0;
    for (let i = 0; i < fb.length; i += 4) {
      // BGR555 0x001F = red. After * 8 expansion: r=248, g=0, b=0.
      if (fb[i] > 200 && fb[i + 1] < 32 && fb[i + 2] < 32) redCount++;
    }
    expect(redCount).toBeGreaterThan(5000);
    expect(redCount).toBeLessThan(7000);
  });
});
