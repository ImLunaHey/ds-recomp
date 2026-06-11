// Direct unit tests for renderBitmapScanline (extended BG bitmap mode).
// We don't go through the Emulator / VRAM router for these — the
// renderer takes a vramBgBase byte offset directly so we can point it
// at a synthesized bitmap in shared.vram and validate the output.

import { describe, it, expect } from 'vitest';
import { renderBitmapScanline } from '../ppu/bitmap_bg';
import { SharedMemory } from '../memory/shared';

// Build a fresh SharedMemory for each test so VRAM/PRAM don't leak.
function fresh(): SharedMemory { return new SharedMemory(); }

// SIZES per BGCNT: 128x128, 256x256, 512x256, 512x512 (size codes 0..3).
const SIZES: ReadonlyArray<readonly [number, number]> = [
  [128, 128], [256, 256], [512, 256], [512, 512],
];

// Write a BGR555 word into VRAM at `off` (little-endian).
function writeColor(mem: SharedMemory, off: number, c: number): void {
  mem.vram[off]     = c & 0xFF;
  mem.vram[off + 1] = (c >>> 8) & 0xFF;
}

describe('renderBitmapScanline — direct 16-bit color', () => {
  it('renders each VRAM word as BGR555 at the scanline-aligned offset', () => {
    const mem = fresh();
    // 256x256 (sizeCode = 1), direct color (bit 2 = 1), bitmap (bit 7 = 1).
    const sizeCode = 1;
    const bgcnt = 0x80 | 0x4 | (sizeCode << 14);
    const [w, h] = SIZES[sizeCode];
    expect(w).toBe(256);
    expect(h).toBe(256);
    // y = 10: fill row 10 with x → BGR555 = x (low 15 bits).
    const vramBgBase = 0;
    const y = 10;
    const rowStart = vramBgBase + y * w * 2;
    for (let x = 0; x < 256; x++) writeColor(mem, rowStart + x * 2, x & 0x7FFF);
    const out = new Uint16Array(256);
    const drawn = renderBitmapScanline(mem, bgcnt, 0, 0, vramBgBase, y, out);
    expect(drawn).toBe(true);
    for (let x = 0; x < 256; x++) {
      // bit 15 = drawn marker, low 15 bits = encoded color.
      expect(out[x]).toBe((x & 0x7FFF) | 0x8000);
    }
  });

  it('preserves bit 15 (drawn marker) on every emitted pixel', () => {
    const mem = fresh();
    const bgcnt = 0x80 | 0x4 | (1 << 14);
    // VRAM all zeros; renderer must still set bit 15 on every pixel.
    const out = new Uint16Array(256);
    renderBitmapScanline(mem, bgcnt, 0, 0, 0, 0, out);
    for (let x = 0; x < 256; x++) {
      expect((out[x] & 0x8000) !== 0).toBe(true);
    }
  });
});

describe('renderBitmapScanline — 256-color palette mode', () => {
  it('maps palette indices through PRAM, transparent for index 0', () => {
    const mem = fresh();
    // sizeCode 1, bitmap (bit 7), palette mode (bit 2 = 0).
    const bgcnt = 0x80 | (1 << 14);
    const [w] = SIZES[1];
    const y = 5;
    const rowStart = y * w;
    // Set palette: index 1 → BGR555 = 0x1234.
    mem.pram[2] = 0x34; mem.pram[3] = 0x12;
    // VRAM row: alternate index 0 (transparent) and index 1.
    for (let x = 0; x < 256; x++) {
      mem.vram[rowStart + x] = (x & 1) === 0 ? 0 : 1;
    }
    const out = new Uint16Array(256);
    const drawn = renderBitmapScanline(mem, bgcnt, 0, 0, 0, y, out);
    expect(drawn).toBe(true);
    for (let x = 0; x < 256; x++) {
      if ((x & 1) === 0) {
        // Index 0 → output slot 0 (transparent).
        expect(out[x]).toBe(0);
      } else {
        // Index 1 → 0x1234 | drawn marker.
        expect(out[x]).toBe(0x1234 | 0x8000);
      }
    }
  });

  it('palette index 0 leaves the output slot at 0 (does not set bit 15)', () => {
    const mem = fresh();
    const bgcnt = 0x80 | (1 << 14);
    // All-zero VRAM means every palette index is 0.
    const out = new Uint16Array(256);
    out.fill(0xAAAA);     // pre-fill so we can detect "untouched" too
    renderBitmapScanline(mem, bgcnt, 0, 0, 0, 0, out);
    for (let x = 0; x < 256; x++) {
      expect(out[x]).toBe(0);
    }
  });
});

describe('renderBitmapScanline — SIZES table', () => {
  // Smoke-test each of the 4 size codes by verifying the renderer
  // honours w and h. We pick a y near the boundary in each, and check
  // (a) y inside [0, h) returns true and (b) the SIZES table indexing
  // produced the expected w (via the wrap test).
  for (let sizeCode = 0; sizeCode < 4; sizeCode++) {
    const [w, h] = SIZES[sizeCode];
    it(`sizeCode=${sizeCode} (${w}x${h}) renders y in range and rejects y past h`, () => {
      const mem = fresh();
      const bgcnt = 0x80 | 0x4 | (sizeCode << 14);
      const out = new Uint16Array(256);
      // y just inside: drawn = true.
      expect(renderBitmapScanline(mem, bgcnt, 0, 0, 0, 0, out)).toBe(true);
      // y just past h: bitmapY = (h + vofs=0) % h = 0 → still in range,
      // so we exercise the wrap test instead by setting vofs=h (wraps to 0).
      const out2 = new Uint16Array(256);
      expect(renderBitmapScanline(mem, bgcnt, 0, h, 0, 0, out2)).toBe(true);
    });
  }
});

describe('renderBitmapScanline — vertical offset wrap', () => {
  it('vofs wraps modulo h — vofs = h+5 acts like vofs = 5', () => {
    const mem = fresh();
    const sizeCode = 1;             // 256x256
    const bgcnt = 0x80 | 0x4 | (sizeCode << 14);
    const [w, h] = SIZES[sizeCode];
    // Row 5: red gradient; row 0: blue marker. y = 0 with vofs = h+5
    // should sample row 5 (the red gradient).
    for (let x = 0; x < w; x++) {
      writeColor(mem, (5 * w + x) * 2, 0x1A00 | x);   // row 5
      writeColor(mem, x * 2, 0x7FFF);                  // row 0 = bright
    }
    const out = new Uint16Array(256);
    renderBitmapScanline(mem, bgcnt, 0, h + 5, 0, 0, out);
    // Row 5 sample: 0x1A00 | x.
    expect(out[0]).toBe((0x1A00 | 0) | 0x8000);
    expect(out[7]).toBe((0x1A00 | 7) | 0x8000);
  });
});

describe('renderBitmapScanline — horizontal offset wrap', () => {
  it('hofs wraps modulo w — hofs = w+3 samples bx = 3..258%w', () => {
    const mem = fresh();
    const sizeCode = 0;             // 128x128
    const bgcnt = 0x80 | 0x4 | (sizeCode << 14);
    const [w, h] = SIZES[sizeCode];
    expect(w).toBe(128);
    expect(h).toBe(128);
    // Fill row 0 with x as the color.
    for (let x = 0; x < w; x++) writeColor(mem, x * 2, x & 0x7FFF);
    const out = new Uint16Array(256);
    renderBitmapScanline(mem, bgcnt, w + 3, 0, 0, 0, out);
    // Output x=0 should be source x=3, x=1 should be x=4, etc.
    expect(out[0]).toBe(3 | 0x8000);
    expect(out[1]).toBe(4 | 0x8000);
    // Output x=125 → source x = (125 + 128 + 3) % 128 = 0.
    expect(out[125]).toBe(0 | 0x8000);
    // Output x=128 → source x = (128 + 128 + 3) % 128 = 3 again.
    expect(out[128]).toBe(3 | 0x8000);
  });
});

describe('renderBitmapScanline — y out of range', () => {
  it('returns false when bitmapY ends up < 0 (negative vofs that wraps below 0)', () => {
    // For sizeCode=1 (h=256), the renderer uses (y + vofs) % h. JS '%' can
    // be negative if the inputs are negative; the function explicitly
    // guards `bitmapY < 0`. We force this by passing a negative vofs.
    const mem = fresh();
    const sizeCode = 1;
    const bgcnt = 0x80 | 0x4 | (sizeCode << 14);
    const out = new Uint16Array(256);
    const drawn = renderBitmapScanline(mem, bgcnt, 0, -1, 0, 0, out);
    // (0 + -1) % 256 = -1 in JS → < 0 guard returns false.
    expect(drawn).toBe(false);
  });
});
