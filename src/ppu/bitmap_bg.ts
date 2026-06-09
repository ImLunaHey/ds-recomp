// Extended BG bitmap renderer for DS engine A/B in DISPCNT modes 3-5.
// BG2 / BG3 can be configured as a bitmap layer when BGxCNT.bit 7 = 1.
// Two sub-modes (per BGxCNT.bit 2):
//   bit 2 = 0: 256-color palette bitmap (8bpp)
//   bit 2 = 1: 16-bit direct color bitmap (BGR555 per pixel)
// Size from BGxCNT bits 14-15: 128x128, 256x256, 512x256, 512x512.
//
// Affine transform on bitmap BGs would normally be applied via the
// affine matrix in 0x04000020+. For our first cut we do an identity
// transform (no scaling/rotation) and treat the bitmap as a screen-
// aligned framebuffer, which is what the obj-mosaic test ROMs do.

import type { SharedMemory } from '../memory/shared';

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [128, 128], [256, 256], [512, 256], [512, 512],
];

// Render one scanline of an extended bitmap BG into `out` (256 BGR555
// samples). Returns true if anything was actually drawn (i.e. y was
// within the bitmap's vertical extent).
export function renderBitmapScanline(
  mem: SharedMemory,
  bgcnt: number,
  hofs: number,
  vofs: number,
  vramBgBase: number,        // start of BG VRAM window in shared.vram
  y: number,
  out: Uint16Array,          // length 256, BGR555 each (bit 15 = drawn?)
): boolean {
  const sizeCode = (bgcnt >>> 14) & 0x3;
  const [w, h] = SIZES[sizeCode];
  const direct = (bgcnt & 0x4) !== 0;        // bit 2 = 1 → 16-bit direct color
  // bitmap-origin in BG VRAM. The "screen base" field at bits 8-12
  // gives a 16 KB unit offset (per GBATEK).
  const baseOff = ((bgcnt >>> 8) & 0x1F) * 0x4000;
  const bitmapStart = vramBgBase + baseOff;

  const bitmapY = (y + vofs) % h;
  if (bitmapY < 0 || bitmapY >= h) return false;

  if (direct) {
    const rowStart = bitmapStart + bitmapY * w * 2;
    for (let x = 0; x < 256; x++) {
      const bx = (x + hofs) % w;
      const off = rowStart + bx * 2;
      const c = mem.vram[off] | (mem.vram[off + 1] << 8);
      out[x] = c | 0x8000;        // bit 15 = drawn marker
    }
  } else {
    // 256-color palette bitmap. Engine A palette starts at PRAM[0],
    // engine B at PRAM[0x400]. We can't tell which from here so the
    // caller is responsible for passing in vramBgBase that matches.
    // (We assume engine A; engine B uses pramBase=0x400 in palette
    // lookup.)
    const pram = mem.pram;
    const rowStart = bitmapStart + bitmapY * w;
    for (let x = 0; x < 256; x++) {
      const bx = (x + hofs) % w;
      const palIdx = mem.vram[rowStart + bx];
      if (palIdx === 0) { out[x] = 0; continue; }
      const c = pram[palIdx * 2] | (pram[palIdx * 2 + 1] << 8);
      out[x] = (c & 0x7FFF) | 0x8000;
    }
  }
  return true;
}
