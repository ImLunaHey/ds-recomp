// OAM-driven sprite rendering. Each engine has 128 OAM entries × 8
// bytes describing position, shape/size, tile data offset, palette,
// priority, flip, mosaic, mode (normal / semi-transparent / OBJ-window).
// Tile data lives in the OBJ VRAM window (0x06400000 for engine A,
// 0x06600000 for engine B); each tile is 4bpp (32 bytes) or 8bpp
// (64 bytes).
//
// This first cut handles plain non-affine sprites in both 4bpp and
// 8bpp modes, 1D + 2D tile mapping, H/V flip, per-pixel transparency
// (palette index 0), and per-sprite priority. Affine + double-size +
// extended palettes + OBJ window come later.

import type { SharedMemory } from '../memory/shared';

// Shape × Size → (W, H) pixel dimensions. From GBATEK §"OBJ Attribute 0".
const SHAPE_SIZE: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[ 8,  8], [16, 16], [32, 32], [64, 64]],   // square
  [[16,  8], [32,  8], [32, 16], [64, 32]],   // horizontal
  [[ 8, 16], [ 8, 32], [16, 32], [32, 64]],   // vertical
  [[ 8,  8], [ 8,  8], [ 8,  8], [ 8,  8]],   // shape=3 is "prohibited"
];

export interface ObjSample {
  // 0 = nothing rendered at this pixel (transparent). Otherwise BGR555 + bits.
  color: number;          // BGR555 in low 15 bits
  priority: number;       // 0..3 (low = top)
  semitransparent: boolean;
}

// Render all sprites for one scanline into `out`, indexed 0..255.
// `pramBase` is 0x200 for engine A / 0x600 for engine B (where OBJ
// palette starts). `vramObjBase` is the start of the OBJ VRAM window
// within shared.vram.
export function renderObjScanline(
  mem: SharedMemory,
  oamBase: number,           // 0 for engine A, 0x400 for engine B
  pramBase: number,          // 0x200 (engine A) or 0x600 (engine B)
  vramObjBase: number,       // 0x06400000 area as flat vram[] offset
  dispcnt: number,
  y: number,
  out: ObjSample[],
): void {
  const oam = mem.oam;
  const vram = mem.vram;
  const pram = mem.pram;

  // DISPCNT bit 4 = OBJ 1D mapping (0 = 2D, 1 = 1D).
  // DISPCNT bits 20:22 = OBJ tile-boundary granularity in 1D mapping
  // (Engine A only — Engine B uses fixed 32-byte boundary).
  const oneDimensional = (dispcnt & 0x10) !== 0;
  const tileBoundaryShift = (dispcnt >>> 20) & 0x3;   // 0..3 → 32 << n bytes
  const tileBoundary = 32 << tileBoundaryShift;        // 32, 64, 128, 256

  for (let s = 0; s < 128; s++) {
    const off = oamBase + s * 8;
    const attr0 = oam[off]     | (oam[off + 1] << 8);
    const attr1 = oam[off + 2] | (oam[off + 3] << 8);
    const attr2 = oam[off + 4] | (oam[off + 5] << 8);

    const rotscale  = (attr0 & 0x0100) !== 0;
    const disabled  = !rotscale && (attr0 & 0x0200) !== 0;
    if (disabled) continue;
    const mode      = (attr0 >>> 10) & 0x3;
    if (mode === 3) continue;                       // bitmap/forbidden
    const mosaic    = (attr0 & 0x1000) !== 0;       // TODO: respect MOSAIC
    void mosaic;
    const is8bpp    = (attr0 & 0x2000) !== 0;
    const shape     = (attr0 >>> 14) & 0x3;
    const size      = (attr1 >>> 14) & 0x3;
    const [w, h]    = SHAPE_SIZE[shape][size];

    // The on-screen Y wraps in 256 pixels.
    let spriteY = attr0 & 0xFF;
    // Double-size flag adds w/h doubled bounding box when affine.
    const doubleSize = rotscale && (attr0 & 0x0200) !== 0;
    const boundsH = doubleSize ? h * 2 : h;
    const boundsW = doubleSize ? w * 2 : w;
    const lineY = (y - spriteY) & 0xFF;
    if (lineY >= boundsH) continue;

    // X with 9-bit sign-extension.
    let spriteX = attr1 & 0x1FF;
    if (spriteX & 0x100) spriteX |= 0xFFFFFE00;       // negative

    const hflip = !rotscale && (attr1 & 0x1000) !== 0;
    const vflip = !rotscale && (attr1 & 0x2000) !== 0;

    const tileNum = attr2 & 0x3FF;
    const priority = (attr2 >>> 10) & 0x3;
    const palBank  = (attr2 >>> 12) & 0xF;

    // Compute the source Y within the sprite (with vflip).
    const srcY = vflip ? (h - 1 - lineY) : lineY;
    if (srcY < 0 || srcY >= h) continue;

    // Sprite tile row index (in 8-pixel tiles).
    const tileRow = srcY >>> 3;
    const subRow  = srcY & 7;
    const tilesPerRow = w >>> 3;

    for (let px = 0; px < w; px++) {
      const screenX = (spriteX + px) | 0;
      if (screenX < 0 || screenX >= 256) continue;
      const srcX = hflip ? (w - 1 - px) : px;
      const tileCol = srcX >>> 3;
      const subCol  = srcX & 7;

      // Locate the tile in OBJ VRAM.
      let tileIndex: number;
      if (oneDimensional) {
        // Tiles laid out contiguously. The "base tile" is shifted by
        // the boundary granularity.
        tileIndex = tileNum + (tileRow * tilesPerRow + tileCol) * (is8bpp ? 2 : 1);
      } else {
        // 2D mapping: each OAM row has 32 tiles (4bpp) or 16 tiles (8bpp).
        // For 8bpp the tile number is effectively half-resolution.
        const baseTile = tileNum;
        const colsPerRow = is8bpp ? 16 : 32;
        tileIndex = baseTile + (tileRow * colsPerRow + tileCol * (is8bpp ? 2 : 1));
      }

      // Each tile is 32 bytes (4bpp) or 64 bytes (8bpp).
      const tileSize = is8bpp ? 64 : 32;
      // For 1D mapping the boundary may be larger than tileSize; the
      // sprite's BASE tile address is tileNum * tileBoundary.
      const baseAddr = oneDimensional
        ? vramObjBase + tileNum * tileBoundary
            + (tileRow * tilesPerRow + tileCol) * tileSize
        : vramObjBase + tileIndex * 32;        // 2D map base = 32-byte units
      void baseAddr;

      // Look up pixel within the tile.
      let palIdx: number;
      if (is8bpp) {
        const addr = oneDimensional
          ? vramObjBase + tileNum * tileBoundary + (tileRow * tilesPerRow + tileCol) * 64 + subRow * 8 + subCol
          : vramObjBase + (tileNum * 32) + (tileRow * 1024 + tileCol * 64) + subRow * 8 + subCol;
        palIdx = vram[addr] | 0;
        if (palIdx === 0) continue;
        // 256-color OBJ palette starts at pramBase.
        const palOff = pramBase + palIdx * 2;
        const c = pram[palOff] | (pram[palOff + 1] << 8);
        const cur = out[screenX];
        if (cur.color === 0 || priority < cur.priority) {
          cur.color = c & 0x7FFF;
          cur.priority = priority;
          cur.semitransparent = mode === 1;
        }
      } else {
        const addr = oneDimensional
          ? vramObjBase + tileNum * tileBoundary + (tileRow * tilesPerRow + tileCol) * 32 + subRow * 4 + (subCol >> 1)
          : vramObjBase + (tileNum * 32) + (tileRow * 1024 + tileCol * 32) + subRow * 4 + (subCol >> 1);
        const byte = vram[addr];
        palIdx = (subCol & 1) ? (byte >> 4) : (byte & 0xF);
        if (palIdx === 0) continue;
        // 4bpp uses palette bank: 16 entries per bank from OBJ palette base.
        const palOff = pramBase + (palBank * 16 + palIdx) * 2;
        const c = pram[palOff] | (pram[palOff + 1] << 8);
        const cur = out[screenX];
        if (cur.color === 0 || priority < cur.priority) {
          cur.color = c & 0x7FFF;
          cur.priority = priority;
          cur.semitransparent = mode === 1;
        }
      }
    }
  }
}

export function newObjLine(): ObjSample[] {
  const a = new Array<ObjSample>(256);
  for (let i = 0; i < 256; i++) a[i] = { color: 0, priority: 4, semitransparent: false };
  return a;
}

export function clearObjLine(line: ObjSample[]): void {
  for (let i = 0; i < 256; i++) {
    const s = line[i];
    s.color = 0; s.priority = 4; s.semitransparent = false;
  }
}
