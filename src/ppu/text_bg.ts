// Text-BG renderer for Engine A / Engine B. Both engines have 4 BGs
// in text mode; this function rasterizes a single 256-pixel scanline
// across all 4 BGs honoring per-BG priority, then composites with the
// backdrop (palette index 0).
//
// This is the "DISPCNT mode 0" path — the common case for most NDS
// 2D content. Other modes (1=BG3 affine, 2=BG2+3 affine, 3..5=bitmap,
// 6=large bitmap) come later.

import type { SharedMemory } from '../memory/shared';

export interface BgRegs {
  // 16-bit BGxCNT for each of 4 BGs.
  cnt: Uint16Array;          // length 4
  // 16-bit horizontal/vertical scroll for each BG.
  hofs: Uint16Array;         // length 4
  vofs: Uint16Array;         // length 4
}

// Render one scanline (256 px) of Engine A or B in text mode 0.
//   y: visible line index (0..191)
//   dispcnt: full DISPCNT
//   pramBase: byte offset into shared.pram (0 = engine A, 0x400 = engine B)
//   bgVramBase: byte offset into shared.vram for this engine's BG window
//   out: 256×4 RGBA output for this line
//
// We use the simplest correct layout: tile data starts at the engine's
// BG VRAM base + DISPCNT_CharBase + BGxCNT_CharBase, map at the same
// base + DISPCNT_ScreenBase + BGxCNT_ScreenBase. For Engine A those
// add bases come from DISPCNT bits 24..26 / 27..29.
export function renderTextScanline(
  mem: SharedMemory,
  regs: BgRegs,
  y: number,
  dispcnt: number,
  pramBase: number,
  bgVramBase: number,
  out: Uint8ClampedArray,
  outRowOffset: number,
  isEngineA: boolean,
): void {
  const vram = mem.vram;
  const pram = mem.pram;

  // Backdrop: palette index 0.
  const backdrop = (pram[pramBase] | (pram[pramBase + 1] << 8)) & 0x7FFF;
  // Per-pixel color (with bit 15 = "drawn").
  const lineColors = new Uint32Array(256);
  for (let x = 0; x < 256; x++) lineColors[x] = backdrop;

  // DISPCNT BG-enable bits: 8 (BG0), 9 (BG1), 10 (BG2), 11 (BG3).
  // Engine A also adds char/screen bases from DISPCNT bits 24..29.
  const charBaseGlobal   = isEngineA ? ((dispcnt >>> 24) & 0x7) * 0x10000 : 0;
  const screenBaseGlobal = isEngineA ? ((dispcnt >>> 27) & 0x7) * 0x10000 : 0;

  // Layer with priority sort: collect (bgIdx, priority) and render in
  // reverse-priority order so lowest-priority BG gets drawn first (and
  // gets overwritten by higher-priority pixels).
  const layers: Array<{ bg: number; priority: number }> = [];
  for (let bg = 0; bg < 4; bg++) {
    if ((dispcnt & (0x100 << bg)) === 0) continue;
    const priority = regs.cnt[bg] & 0x3;
    layers.push({ bg, priority });
  }
  // Stable sort: highest priority value (= drawn last / appears on top? no —
  // priority 0 = highest = drawn on top. We want priority 3 drawn first.)
  layers.sort((a, b) => b.priority - a.priority);

  for (const { bg } of layers) {
    const cnt = regs.cnt[bg];
    const is8bpp     = (cnt & 0x80) !== 0;
    const charBase   = ((cnt >>> 2) & 0xF) * 0x4000 + charBaseGlobal;
    const screenBase = ((cnt >>> 8) & 0x1F) * 0x800 + screenBaseGlobal;
    const sizeCode   = (cnt >>> 14) & 0x3;
    const sizeW = (sizeCode === 1 || sizeCode === 3) ? 512 : 256;
    const sizeH = (sizeCode === 2 || sizeCode === 3) ? 512 : 256;

    const hofs = regs.hofs[bg];
    const vofs = regs.vofs[bg];
    const worldY = (y + vofs) & (sizeH - 1);

    for (let x = 0; x < 256; x++) {
      const worldX = (x + hofs) & (sizeW - 1);
      // Pick the 256×256 screen block we're in (for sizes >256).
      const block = ((worldY >= 256 ? 2 : 0) | (worldX >= 256 ? 1 : 0));
      const localY = worldY & 0xFF;
      const localX = worldX & 0xFF;
      const tileY = localY >> 3;
      const tileX = localX >> 3;
      const screenEntryAddr = (bgVramBase + screenBase + block * 0x800 +
                               (tileY * 32 + tileX) * 2) >>> 0;
      const entry = vram[screenEntryAddr] | (vram[screenEntryAddr + 1] << 8);
      const tileNum    = entry & 0x3FF;
      const hFlip      = (entry & 0x400) !== 0;
      const vFlip      = (entry & 0x800) !== 0;
      const palBank    = (entry >>> 12) & 0xF;

      let pixY = localY & 7;
      let pixX = localX & 7;
      if (vFlip) pixY ^= 7;
      if (hFlip) pixX ^= 7;

      let colorIdx: number;
      if (is8bpp) {
        // 64 bytes per tile.
        const tileAddr = bgVramBase + charBase + tileNum * 64;
        colorIdx = vram[tileAddr + pixY * 8 + pixX];
        if (colorIdx === 0) continue;
        const palOff = pramBase + colorIdx * 2;
        const c = pram[palOff] | (pram[palOff + 1] << 8);
        lineColors[x] = c & 0x7FFF;
      } else {
        // 32 bytes per tile (4bpp).
        const tileAddr = bgVramBase + charBase + tileNum * 32;
        const byte = vram[tileAddr + pixY * 4 + (pixX >> 1)];
        colorIdx = (pixX & 1) ? (byte >> 4) : (byte & 0xF);
        if (colorIdx === 0) continue;
        const palOff = pramBase + (palBank * 16 + colorIdx) * 2;
        const c = pram[palOff] | (pram[palOff + 1] << 8);
        lineColors[x] = c & 0x7FFF;
      }
    }
  }

  // Emit BGR555 → RGBA8.
  for (let x = 0; x < 256; x++) {
    const c = lineColors[x];
    const dst = outRowOffset + x * 4;
    out[dst]     = ((c >>  0) & 0x1F) * 8;
    out[dst + 1] = ((c >>  5) & 0x1F) * 8;
    out[dst + 2] = ((c >> 10) & 0x1F) * 8;
    out[dst + 3] = 0xFF;
  }
}
