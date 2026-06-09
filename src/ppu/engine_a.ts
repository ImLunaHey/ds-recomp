// Engine A/B frame composer. Picks the path based on DISPCNT bits
// 16..17 (display mode) and 0..2 (BG mode). Currently supports:
//
//   displayMode 0: forced blank → white
//   displayMode 1, BG mode 0: text BGs (BG0..BG3 in priority order)
//   displayMode 2: LCDC VRAM-bank direct display (256x192 BGR555)
//
// Anything else falls back to backdrop-only.

import { Ppu, SCREEN_W, SCREEN_H } from './ppu';
import { renderTextScanline, type BgRegs } from './text_bg';

const ENGINE_A_PRAM = 0;        // 1 KB block for engine A
const ENGINE_B_PRAM = 0x400;    // 1 KB block for engine B
// Engine A BG VRAM window starts at the beginning of VRAM; Engine B's
// window is conventionally 512 KB in (bank D's typical assignment).
const ENGINE_A_BG_VRAM_BASE = 0;
const ENGINE_B_BG_VRAM_BASE = 0x80000;

export function renderEngineA(ppu: Ppu): void {
  renderEngine(ppu, ppu.dispcntA, ppu.fbA, ENGINE_A_PRAM, ENGINE_A_BG_VRAM_BASE, true,
    { cnt: ppu.bgCntA, hofs: ppu.bgHofsA, vofs: ppu.bgVofsA });
}

export function renderEngineB(ppu: Ppu): void {
  renderEngine(ppu, ppu.dispcntB, ppu.fbB, ENGINE_B_PRAM, ENGINE_B_BG_VRAM_BASE, false,
    { cnt: ppu.bgCntB, hofs: ppu.bgHofsB, vofs: ppu.bgVofsB });
}

function renderEngine(
  ppu: Ppu,
  dispcnt: number,
  fb: Uint8ClampedArray,
  pramBase: number,
  bgVramBase: number,
  isEngineA: boolean,
  bgRegs: BgRegs,
): void {
  const displayMode = (dispcnt >>> 16) & 0x3;

  if (displayMode === 0) {
    // Forced blank — white.
    for (let i = 0; i < fb.length; i += 4) {
      fb[i] = 0xFF; fb[i + 1] = 0xFF; fb[i + 2] = 0xFF; fb[i + 3] = 0xFF;
    }
    return;
  }

  if (displayMode === 2) {
    // LCDC direct display — read VRAM bank as raw 256×192 BGR555.
    const bank = (dispcnt >>> 18) & 0x3;
    const off = bank * 128 * 1024;
    const vram = ppu.mem.vram;
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const p = off + (y * SCREEN_W + x) * 2;
        const c = vram[p] | (vram[p + 1] << 8);
        writePixel(fb, x, y, c);
      }
    }
    return;
  }

  // Graphics display (mode 1). BG mode 0 = all-text, the common case.
  const bgMode = dispcnt & 0x7;
  if (bgMode === 0) {
    for (let y = 0; y < SCREEN_H; y++) {
      renderTextScanline(ppu.mem, bgRegs, y, dispcnt, pramBase, bgVramBase,
                         fb, y * SCREEN_W * 4, isEngineA);
    }
    return;
  }

  // Other BG modes (affine/bitmap) — fall back to backdrop fill for now.
  const pram = ppu.mem.pram;
  const backdrop = pram[pramBase] | (pram[pramBase + 1] << 8);
  for (let i = 0; i < SCREEN_W * SCREEN_H; i++) {
    writePixel(fb, i % SCREEN_W, (i / SCREEN_W) | 0, backdrop);
  }
}

function writePixel(fb: Uint8ClampedArray, x: number, y: number, bgr555: number): void {
  const idx = (y * SCREEN_W + x) * 4;
  fb[idx]     = ((bgr555 >>  0) & 0x1F) * 8;
  fb[idx + 1] = ((bgr555 >>  5) & 0x1F) * 8;
  fb[idx + 2] = ((bgr555 >> 10) & 0x1F) * 8;
  fb[idx + 3] = 0xFF;
}
