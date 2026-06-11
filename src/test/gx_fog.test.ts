// Unit tests for the 3D fog + edge-mark post-process helpers.

import { describe, it, expect } from 'vitest';
import { applyFog, applyEdgeMark } from '../ppu/gx_fog';

describe('gx_fog — applyFog', () => {
  it('zero density returns the input color unchanged', () => {
    const table = new Uint8Array(32);
    // All entries already 0.
    const color = 0x8000 | 0x001F;   // drawn + red
    const out = applyFog(color, 0, table, 0, 0x7C00 /* blue fog */);
    expect(out).toBe(color);
  });

  it('full (127) density blends almost entirely to the fog color', () => {
    const table = new Uint8Array(32);
    table.fill(127);
    const color = 0x8000 | 0x001F;   // drawn + red
    const fog = 0x7C00;              // blue
    const out = applyFog(color, 0, table, 0, fog);
    // Should be almost the fog color. Red channel near 0, blue near 31.
    expect(out & 0x1F).toBeLessThan(2);
    expect((out >>> 10) & 0x1F).toBeGreaterThan(28);
    // Drawn bit preserved.
    expect(out & 0x8000).toBe(0x8000);
  });

  it('mid density (64) blends to roughly half-and-half', () => {
    const table = new Uint8Array(32);
    table.fill(64);
    const color = 0x001F;            // pure red, channel = 31
    const fog = 0x7C00;              // pure blue, channel = 31
    const out = applyFog(color, 0, table, 0, fog);
    const r = out & 0x1F;
    const b = (out >>> 10) & 0x1F;
    // Both channels should be roughly 15-16.
    expect(r).toBeGreaterThan(13);
    expect(r).toBeLessThan(18);
    expect(b).toBeGreaterThan(13);
    expect(b).toBeLessThan(18);
  });

  it('z below fog offset uses table[0]', () => {
    const table = new Uint8Array(32);
    table[0] = 64;
    // Note: relZ = z - fogOffset = 100 - 1000 < 0 → idx = 0.
    const color = 0x001F;
    const out = applyFog(color, 100, table, 1000, 0x7C00);
    // Should have blended (because table[0] = 64).
    expect(out).not.toBe(color);
  });

  it('z saturates above table-end into the last density entry', () => {
    const table = new Uint8Array(32);
    table[31] = 100;
    const out = applyFog(0x001F, 0xFFFF, table, 0, 0x7C00);
    expect(out).not.toBe(0x001F);
  });
});

describe('gx_fog — applyEdgeMark', () => {
  it('interior pixel (all neighbours drawn) is unchanged', () => {
    const w = 4, h = 4;
    const mask = new Uint8Array(w * h);
    mask.fill(1);     // everything drawn
    const out = applyEdgeMark(0x001F, 2, 2, w, h, mask, 0xFFFF);
    expect(out).toBe(0x001F);
  });

  it('edge pixel (a neighbour is undrawn) is replaced by the edge color', () => {
    const w = 4, h = 4;
    const mask = new Uint8Array(w * h);
    // Bottom-right 3 cells of row 1 drawn, plus interior. Pixel (1,1) is
    // drawn but its (0,1) neighbour is not — should be marked.
    mask[1 * w + 1] = 1;
    mask[1 * w + 2] = 1;
    const out = applyEdgeMark(0x001F, 1, 1, w, h, mask, 0x7C00);
    expect(out & 0x7FFF).toBe(0x7C00);
  });

  it('undrawn pixel is left alone (no marking on background)', () => {
    const w = 4, h = 4;
    const mask = new Uint8Array(w * h);
    mask[1 * w + 1] = 1;       // single drawn pixel surrounded by undrawn
    // Query at (0,0) — undrawn. Should return input unchanged.
    const out = applyEdgeMark(0xAAAA, 0, 0, w, h, mask, 0x7C00);
    expect(out).toBe(0xAAAA);
  });

  it('boundary pixel (corner of the screen) marks against the off-screen "undrawn"', () => {
    const w = 4, h = 4;
    const mask = new Uint8Array(w * h);
    mask.fill(1);
    // Corner pixel at (0,0): the (left/up) neighbours are off-screen and
    // treated as undrawn → should be marked.
    const out = applyEdgeMark(0x001F, 0, 0, w, h, mask, 0x7C00);
    expect(out & 0x7FFF).toBe(0x7C00);
  });
});
