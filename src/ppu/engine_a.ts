// Engine A/B frame composer. Dispatches per DISPCNT display mode and
// per-BG mode. Per-pixel priority compositing across text BGs,
// extended-bitmap BGs (BG2/BG3 in DISPCNT modes 3-5), and sprites.

import { Ppu, SCREEN_W, SCREEN_H } from './ppu';
import { renderTextScanline } from './text_bg';
import { renderBitmapScanline } from './bitmap_bg';
import { renderObjScanline, newObjLine, clearObjLine } from './sprites';

const ENGINE_A_PRAM = 0;
const ENGINE_B_PRAM = 0x400;
const ENGINE_A_BG_VRAM_BASE = 0;
const ENGINE_B_BG_VRAM_BASE = 0x80000;       // bank C typical mapping
const ENGINE_A_OBJ_VRAM_BASE = 0x20000;      // bank B typical mapping
const ENGINE_B_OBJ_VRAM_BASE = 0x90000;      // bank D typical mapping
const ENGINE_A_OAM_BASE = 0;
const ENGINE_B_OAM_BASE = 0x400;

export function renderEngineA(ppu: Ppu): void {
  renderEngine(ppu, ppu.dispcntA, ppu.fbA, true);
}

export function renderEngineB(ppu: Ppu): void {
  renderEngine(ppu, ppu.dispcntB, ppu.fbB, false);
}

// Reused per-scanline buffers. BG line slots hold {color, drawn?, layer}
// — represented as Uint16 where bit 15 = drawn. The SCREEN_W constant
// from ppu.ts isn't usable here because engine_a is imported by ppu.ts;
// at module-load time SCREEN_W is undefined inside that circular chain.
// Inline the literal 256 to dodge the TDZ.
const BG_LINE_W = 256;
const bgLine0 = new Uint16Array(BG_LINE_W);
const bgLine1 = new Uint16Array(BG_LINE_W);
const bgLine2 = new Uint16Array(BG_LINE_W);
const bgLine3 = new Uint16Array(BG_LINE_W);
const objLineCache = newObjLine();

function renderEngine(ppu: Ppu, dispcnt: number, fb: Uint8ClampedArray, isEngineA: boolean): void {
  const displayMode = (dispcnt >>> 16) & 0x3;

  if (displayMode === 0) {
    // Forced blank → white.
    for (let i = 0; i < fb.length; i += 4) {
      fb[i] = 0xFF; fb[i + 1] = 0xFF; fb[i + 2] = 0xFF; fb[i + 3] = 0xFF;
    }
    return;
  }

  if (displayMode === 2) {
    // LCDC bank-direct display.
    const bank = (dispcnt >>> 18) & 0x3;
    const off = bank * 128 * 1024;
    const vram = ppu.mem.vram;
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const p = off + (y * SCREEN_W + x) * 2;
        writePixel(fb, x, y, vram[p] | (vram[p + 1] << 8));
      }
    }
    return;
  }

  // Graphics display (mode 1) — composite BGs + OBJ per scanline.
  const pramBase  = isEngineA ? ENGINE_A_PRAM     : ENGINE_B_PRAM;
  const bgVramBase = isEngineA ? ENGINE_A_BG_VRAM_BASE  : ENGINE_B_BG_VRAM_BASE;
  const objVramBase = isEngineA ? ENGINE_A_OBJ_VRAM_BASE : ENGINE_B_OBJ_VRAM_BASE;
  const oamBase   = isEngineA ? ENGINE_A_OAM_BASE : ENGINE_B_OAM_BASE;
  const objPramBase = pramBase + 0x200;

  const bgCnt  = isEngineA ? ppu.bgCntA  : ppu.bgCntB;
  const bgHofs = isEngineA ? ppu.bgHofsA : ppu.bgHofsB;
  const bgVofs = isEngineA ? ppu.bgVofsA : ppu.bgVofsB;
  const bgRegs = { cnt: bgCnt, hofs: bgHofs, vofs: bgVofs };

  const bgMode = dispcnt & 0x7;
  const objEnabled = (dispcnt & 0x1000) !== 0;
  const bgEnables = (dispcnt >>> 8) & 0xF;

  // Backdrop = palette index 0.
  const backdrop = (ppu.mem.pram[pramBase] | (ppu.mem.pram[pramBase + 1] << 8)) & 0x7FFF;

  // Which BGs are bitmap in extended modes?
  function isBgBitmap(bg: number): boolean {
    if (bg < 2) return false;
    if (bgMode < 3) return false;
    if (bgMode === 6 && bg === 2) return true;       // large bitmap
    // Mode 3-5: BGxCNT bit 7 = 1 means bitmap mode (for BG2/BG3 if active).
    return (bgCnt[bg] & 0x80) !== 0;
  }

  function isBgEnabled(bg: number): boolean {
    if ((bgEnables & (1 << bg)) === 0) return false;
    // Mode 0: all 4 text. Mode 1: BG0-2 text, BG3 ext. Mode 2: BG0,1 text,
    // BG2,3 affine. Mode 3-5: extended BGs. Mode 6: BG2 large bitmap only.
    if (bgMode === 6 && bg !== 2) return false;
    return true;
  }

  const bgLines = [bgLine0, bgLine1, bgLine2, bgLine3];

  for (let y = 0; y < SCREEN_H; y++) {
    // Clear BG lines + OBJ line.
    for (let bg = 0; bg < 4; bg++) bgLines[bg].fill(0);
    clearObjLine(objLineCache);

    for (let bg = 0; bg < 4; bg++) {
      if (!isBgEnabled(bg)) continue;
      if (isBgBitmap(bg)) {
        renderBitmapScanline(ppu.mem, bgCnt[bg], bgHofs[bg], bgVofs[bg],
                             bgVramBase, y, bgLines[bg]);
      } else if (bgMode === 0 || bg < 2 || (bgMode === 1 && bg !== 3) ||
                 (bgMode === 2 && bg < 2)) {
        // Text mode for this BG. Use a temporary FB-style buffer.
        const lineRgba = scratchTextLine;
        renderTextScanline(ppu.mem, bgRegs, y, dispcnt, pramBase, bgVramBase,
                           lineRgba, 0, isEngineA);
        // The text renderer wrote RGBA. We need to recapture as BGR555
        // with a "drawn" bit. Anything not equal to the backdrop is
        // considered drawn.
        for (let x = 0; x < SCREEN_W; x++) {
          const r = lineRgba[x * 4 + 0] >> 3;
          const g = lineRgba[x * 4 + 1] >> 3;
          const b = lineRgba[x * 4 + 2] >> 3;
          const c = (b << 10) | (g << 5) | r;
          if (c !== backdrop) bgLines[bg][x] = c | 0x8000;
        }
      } else {
        // Affine BG / unsupported sub-mode — leave transparent.
      }
    }

    // 3D engine overrides BG0 (Engine A only) when DISPCNT bit 3 is set.
    // GX writes BGR555 | 0x8000 for "drawn" pixels, matching our format.
    if (isEngineA && (dispcnt & 0x8) !== 0) {
      const fbFront = ppu.gx.fbFront;
      const rowBase = y * SCREEN_W;
      for (let x = 0; x < SCREEN_W; x++) {
        bgLines[0][x] = fbFront[rowBase + x];
      }
    }

    // OBJ layer.
    if (objEnabled) {
      const mosaicReg = isEngineA ? ppu.mosaicA : ppu.mosaicB;
      renderObjScanline(ppu.mem, oamBase, objPramBase, objVramBase,
                       dispcnt, mosaicReg, y, objLineCache);
    }

    // Per-pixel priority compositing. Each BG has a priority from its
    // BGxCNT.bits 0:1. OBJ priority comes from each sprite (highest
    // wins among overlapping sprites per pixel — already resolved in
    // objLineCache).
    const rowOff = y * SCREEN_W * 4;
    for (let x = 0; x < SCREEN_W; x++) {
      let best = backdrop;
      let bestPriority = 5;
      // Track best per-pixel layer choice.
      for (let bg = 0; bg < 4; bg++) {
        const v = bgLines[bg][x];
        if ((v & 0x8000) === 0) continue;
        const pri = bgCnt[bg] & 0x3;
        if (pri < bestPriority) {
          best = v & 0x7FFF;
          bestPriority = pri;
        }
      }
      const obj = objLineCache[x];
      if (obj.color !== 0 && obj.priority <= bestPriority) {
        best = obj.color;
        bestPriority = obj.priority;
      }
      writePixelAt(fb, rowOff + x * 4, best);
    }
  }
}

const scratchTextLine = new Uint8ClampedArray(BG_LINE_W * 4);

function writePixelAt(fb: Uint8ClampedArray, idx: number, bgr555: number): void {
  fb[idx]     = ((bgr555 >>  0) & 0x1F) * 8;
  fb[idx + 1] = ((bgr555 >>  5) & 0x1F) * 8;
  fb[idx + 2] = ((bgr555 >> 10) & 0x1F) * 8;
  fb[idx + 3] = 0xFF;
}

function writePixel(fb: Uint8ClampedArray, x: number, y: number, bgr555: number): void {
  writePixelAt(fb, (y * SCREEN_W + x) * 4, bgr555);
}
