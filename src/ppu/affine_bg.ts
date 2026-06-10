// Affine BG renderer (BG2 / BG3) for DS engine A and B.
//
// Three sub-modes are dispatched here:
//   - Affine tile mode (BGxCNT bit 7 = 0, in DISPCNT modes 1/2/3/4/5
//     where the BG is on an "affine" slot): 8-bit tile indices in the
//     screen map, 256-color tile pixels in char data, affine transform
//     applied per pixel.
//   - Extended-affine palette bitmap (BGxCNT bit 7 = 1, bit 2 = 0): a
//     256-color bitmap sampled with the affine transform.
//   - Extended-affine direct bitmap (BGxCNT bit 7 = 1, bit 2 = 1): a
//     BGR555 direct-color bitmap sampled with the affine transform.
//
// The affine math is:
//   worldX = (refXLatched + PA*x) >> 8
//   worldY = (refYLatched + PC*x) >> 8
// with PA/PC summed across x in Q8.8 fixed-point. The PB/PD per-line
// advance is applied by the caller (engine_a.ts), which bumps the
// latched references at the end of each scanline.
//
// Wraparound is controlled by BGxCNT bit 13: when set, out-of-bounds
// samples wrap modulo the BG size; when clear, they read transparent
// (palette index 0 for tile/palette modes, color 0 / not-drawn for
// direct color).
//
// Output convention matches text_bg / bitmap_bg: each entry in `out`
// is a 16-bit BGR555 color with bit 15 set when "drawn" (opaque) and
// 0 when transparent. The caller composites this into the priority
// list.

import type { Ppu } from './ppu';

// Affine TILE-mode sizes (BGxCNT bit 7 = 0). These are SQUARE — the
// "size" field's bit pattern is the log2 of width in tiles.
//   00 →  16×16 tiles ( 128×128 px)
//   01 →  32×32 tiles ( 256×256 px)
//   10 →  64×64 tiles ( 512×512 px)
//   11 → 128×128 tiles (1024×1024 px)
const AFFINE_TILE_SIZES: ReadonlyArray<readonly [number, number]> = [
  [128, 128], [256, 256], [512, 512], [1024, 1024],
];

// Extended-BITMAP sizes (BGxCNT bit 7 = 1). Note these are NOT the same
// as the affine-tile sizes for codes 2/3:
//   00 → 128×128
//   01 → 256×256
//   10 → 512×256
//   11 → 512×512
const EXT_BITMAP_SIZES: ReadonlyArray<readonly [number, number]> = [
  [128, 128], [256, 256], [512, 256], [512, 512],
];

// Sub-mode discriminator for the renderer dispatcher.
export const enum AffineSubMode {
  Tile = 0,
  BitmapPalette = 1,
  BitmapDirect = 2,
}

// Decide which sub-mode a given BG is using inside an "extended" BG
// slot. Tile-affine when bit 7 = 0; otherwise bitmap, with bit 2
// distinguishing palette vs direct color.
//
// `forceTile` short-circuits the bit-7 check for "plain affine" slots
// (DISPCNT modes 1/2/4 — see engine_a.ts bgSlotKind). On those slots
// the affine sub-mode is fixed to tile regardless of BGxCNT bit 7.
export function affineSubModeFor(bgcnt: number, forceTile: boolean): AffineSubMode {
  if (forceTile || (bgcnt & 0x80) === 0) return AffineSubMode.Tile;
  return (bgcnt & 0x4) !== 0 ? AffineSubMode.BitmapDirect : AffineSubMode.BitmapPalette;
}

// Render a single affine-BG scanline into `out` (256 BGR555 entries
// with bit 15 = drawn). `bg` must be 2 or 3 — only BG2/BG3 are affine-
// capable on DS hardware.
export function renderAffineBgScanline(
  ppu: Ppu,
  isEngineA: boolean,
  bg: number,
  bgVramBase: number,
  pramBase: number,
  charBaseExtra: number,
  screenBaseExtra: number,
  forceTile: boolean,
  out: Uint16Array,
): void {
  const bgcnt = (isEngineA ? ppu.bgCntA : ppu.bgCntB)[bg];
  const subMode = affineSubModeFor(bgcnt, forceTile);

  // BG size table depends on sub-mode (tile-affine vs extended-bitmap
  // sizes differ for codes 2/3).
  const sizeCode = (bgcnt >>> 14) & 0x3;
  const [w, h] = subMode === AffineSubMode.Tile
    ? AFFINE_TILE_SIZES[sizeCode]
    : EXT_BITMAP_SIZES[sizeCode];

  // BGxCNT bit 13 = "wraparound enable". When set, out-of-bounds
  // samples wrap mod size; when clear, they read transparent. Real
  // hardware only honours this bit on affine slots — text BGs always
  // wrap — so the gate is simple here.
  const wrap = (bgcnt & 0x2000) !== 0;

  const pa = isEngineA ? ppu.bgPA_A[bg] : ppu.bgPA_B[bg];
  const pc = isEngineA ? ppu.bgPC_A[bg] : ppu.bgPC_B[bg];
  const refX = isEngineA ? ppu.bgRefXLatched_A[bg] : ppu.bgRefXLatched_B[bg];
  const refY = isEngineA ? ppu.bgRefYLatched_A[bg] : ppu.bgRefYLatched_B[bg];

  if (subMode === AffineSubMode.Tile) {
    renderAffineTile(ppu, bgcnt, bgVramBase, pramBase, charBaseExtra, screenBaseExtra,
                     w, h, wrap, refX, refY, pa, pc, out);
  } else if (subMode === AffineSubMode.BitmapPalette) {
    renderAffineBitmapPalette(ppu, bgcnt, bgVramBase, pramBase,
                              w, h, wrap, refX, refY, pa, pc, out);
  } else {
    renderAffineBitmapDirect(ppu, bgcnt, bgVramBase, w, h, wrap, refX, refY, pa, pc, out);
  }
}

// Affine TILE mode: 8-bit tile index in the screen map, 256-color
// (8bpp) tile pixels. Each tile is 64 bytes (8×8 × 1 byte/pixel). The
// screen map is one byte per entry (NOT two, like text mode), so its
// stride is (w/8) bytes per row of tiles.
function renderAffineTile(
  ppu: Ppu,
  bgcnt: number,
  bgVramBase: number,
  pramBase: number,
  charBaseExtra: number,
  screenBaseExtra: number,
  w: number,
  h: number,
  wrap: boolean,
  refX: number,
  refY: number,
  pa: number,
  pc: number,
  out: Uint16Array,
): void {
  const vram = ppu.mem.vram;
  const pram = ppu.mem.pram;
  // Screen/char bases: same encoding as text-mode BG. Bits 8..12 give
  // a screen-base in 0x800 units, bits 2..5 a char-base in 0x4000.
  // Engine A adds its own "global" base from DISPCNT bits 24..29 which
  // the caller passes in as charBaseExtra / screenBaseExtra — they're
  // zero for engine B.
  const screenBase = ((bgcnt >>> 8) & 0x1F) * 0x800  + screenBaseExtra;
  const charBase   = ((bgcnt >>> 2) & 0xF)  * 0x4000 + charBaseExtra;
  const tilesPerRow = w >> 3;

  let curX = refX;
  let curY = refY;
  for (let x = 0; x < 256; x++) {
    const worldX = curX >> 8;
    const worldY = curY >> 8;
    curX += pa;
    curY += pc;

    let wx = worldX;
    let wy = worldY;
    if (wrap) {
      wx = ((wx % w) + w) % w;
      wy = ((wy % h) + h) % h;
    } else if (wx < 0 || wx >= w || wy < 0 || wy >= h) {
      out[x] = 0;
      continue;
    }

    const tileX = wx >> 3;
    const tileY = wy >> 3;
    const tileNum = vram[(bgVramBase + screenBase + tileY * tilesPerRow + tileX) >>> 0];
    const pxOff = bgVramBase + charBase + tileNum * 64 + (wy & 7) * 8 + (wx & 7);
    const palIdx = vram[pxOff >>> 0];
    if (palIdx === 0) { out[x] = 0; continue; }
    const c = pram[pramBase + palIdx * 2] | (pram[pramBase + palIdx * 2 + 1] << 8);
    out[x] = (c & 0x7FFF) | 0x8000;
  }
}

// Extended-affine 256-color bitmap. The bitmap origin in VRAM is the
// BGxCNT "screen base" field × 0x4000 (same as bitmap_bg.ts uses).
function renderAffineBitmapPalette(
  ppu: Ppu,
  bgcnt: number,
  bgVramBase: number,
  pramBase: number,
  w: number,
  h: number,
  wrap: boolean,
  refX: number,
  refY: number,
  pa: number,
  pc: number,
  out: Uint16Array,
): void {
  const vram = ppu.mem.vram;
  const pram = ppu.mem.pram;
  const baseOff = ((bgcnt >>> 8) & 0x1F) * 0x4000;
  const bitmapStart = bgVramBase + baseOff;

  let curX = refX;
  let curY = refY;
  for (let x = 0; x < 256; x++) {
    const worldX = curX >> 8;
    const worldY = curY >> 8;
    curX += pa;
    curY += pc;

    let wx = worldX;
    let wy = worldY;
    if (wrap) {
      wx = ((wx % w) + w) % w;
      wy = ((wy % h) + h) % h;
    } else if (wx < 0 || wx >= w || wy < 0 || wy >= h) {
      out[x] = 0;
      continue;
    }

    const palIdx = vram[(bitmapStart + wy * w + wx) >>> 0];
    if (palIdx === 0) { out[x] = 0; continue; }
    const c = pram[pramBase + palIdx * 2] | (pram[pramBase + palIdx * 2 + 1] << 8);
    out[x] = (c & 0x7FFF) | 0x8000;
  }
}

// Extended-affine 16-bit direct-color bitmap (BGR555 per pixel). The
// "drawn" bit (bit 15) is taken directly from the source pixel — DS
// honours bit 15 as alpha for direct-color bitmaps, so a pixel with
// bit 15 = 0 reads as transparent.
function renderAffineBitmapDirect(
  ppu: Ppu,
  bgcnt: number,
  bgVramBase: number,
  w: number,
  h: number,
  wrap: boolean,
  refX: number,
  refY: number,
  pa: number,
  pc: number,
  out: Uint16Array,
): void {
  const vram = ppu.mem.vram;
  const baseOff = ((bgcnt >>> 8) & 0x1F) * 0x4000;
  const bitmapStart = bgVramBase + baseOff;

  let curX = refX;
  let curY = refY;
  for (let x = 0; x < 256; x++) {
    const worldX = curX >> 8;
    const worldY = curY >> 8;
    curX += pa;
    curY += pc;

    let wx = worldX;
    let wy = worldY;
    if (wrap) {
      wx = ((wx % w) + w) % w;
      wy = ((wy % h) + h) % h;
    } else if (wx < 0 || wx >= w || wy < 0 || wy >= h) {
      out[x] = 0;
      continue;
    }

    const off = bitmapStart + (wy * w + wx) * 2;
    const c = vram[off] | (vram[off + 1] << 8);
    // Per GBATEK, bit 15 = alpha for direct-color bitmaps. Honour it.
    if ((c & 0x8000) === 0) { out[x] = 0; continue; }
    out[x] = c & 0xFFFF;
  }
}

// Advance the latched reference for an affine BG by one scanline.
// Called at the end of each visible scanline by engine_a.ts so the
// next line samples from refX + PB, refY + PD. This matches GBATEK's
// "PB/PD added at HBlank" behaviour.
export function advanceAffineRefForScanline(ppu: Ppu, isEngineA: boolean, bg: number): void {
  if (isEngineA) {
    ppu.bgRefXLatched_A[bg] = (ppu.bgRefXLatched_A[bg] + ppu.bgPB_A[bg]) | 0;
    ppu.bgRefYLatched_A[bg] = (ppu.bgRefYLatched_A[bg] + ppu.bgPD_A[bg]) | 0;
  } else {
    ppu.bgRefXLatched_B[bg] = (ppu.bgRefXLatched_B[bg] + ppu.bgPB_B[bg]) | 0;
    ppu.bgRefYLatched_B[bg] = (ppu.bgRefYLatched_B[bg] + ppu.bgPD_B[bg]) | 0;
  }
}
