// Engine A/B frame composer. Dispatches per DISPCNT display mode and
// per-BG mode. Per-pixel priority compositing across text BGs,
// extended-bitmap BGs (BG2/BG3 in DISPCNT modes 3-5), and sprites.
//
// On top of layer compositing we model the post-process pipeline:
//   1. Window regions (WIN0/WIN1/OBJWIN/OUT) gate which BGs / OBJ / the
//      special-effects layer contribute on a per-pixel basis.
//   2. Color special effects (BLDCNT/BLDALPHA/BLDY) apply alpha blend
//      or brightness fade between the top two layers per pixel.
//   3. MASTER_BRIGHT applies a final fade-to-white / fade-to-black pass
//      after compositing.
//   4. Display capture (engine A only) copies the composited output
//      back into a VRAM bank when DISPCAPCNT bit 31 is set.

import { Ppu, SCREEN_W, SCREEN_H } from './ppu';
import { renderTextScanline } from './text_bg';
import { renderBitmapScanline } from './bitmap_bg';
import { renderObjScanline, newObjLine, clearObjLine } from './sprites';
import { getActiveVramRouter } from '../memory/vram_router';

const ENGINE_A_PRAM = 0;
const ENGINE_B_PRAM = 0x400;
// Fallback bases used when the router can't resolve the current BG/OBJ
// window for an engine. Real games configure VRAMCNT before enabling
// the relevant DISPCNT bits, so the fallback is unreachable for any
// game with a correct setup. Kept here for reset-time renders and
// any test that touches the renderer without configuring VRAMCNT.
const FALLBACK_ENGINE_A_BG = 0;          // bank A typical
const FALLBACK_ENGINE_B_BG = 0x40000;    // bank C typical
const FALLBACK_ENGINE_A_OBJ = 0x20000;   // bank B typical
const FALLBACK_ENGINE_B_OBJ = 0x60000;   // bank D typical (was 0x90000 = bank F, wrong)
const ENGINE_A_OAM_BASE = 0;
const ENGINE_B_OAM_BASE = 0x400;

// Resolve the current VRAM slot offset for an engine's BG / OBJ window
// by asking the router which bank is mapped there. Returns the flat
// offset into shared.vram (NOT the bank index). The window address
// passed in is one of:
//   0x06000000 (engine A BG), 0x06400000 (engine A OBJ),
//   0x06200000 (engine B BG), 0x06600000 (engine B OBJ).
function resolveVramBase(addr: number, fallback: number): number {
  const router = getActiveVramRouter();
  if (!router) return fallback;
  const idx = router.resolveArm9(addr);
  return idx >= 0 ? idx : fallback;
}

// Layer indices used as bit positions into WININ / WINOUT / BLDCNT
// target masks. BG0..3 use their own index; OBJ is bit 4; backdrop is
// bit 5 (matches BLDCNT bit 5 = backdrop target A).
const LAYER_OBJ = 4;
const LAYER_BACKDROP = 5;

export function renderEngineA(ppu: Ppu): void {
  renderEngine(ppu, ppu.dispcntA, ppu.fbA, true);
  applyMasterBrightness(ppu.fbA, ppu.masterBrightA);
  applyDisplayCapture(ppu);
}

export function renderEngineB(ppu: Ppu): void {
  renderEngine(ppu, ppu.dispcntB, ppu.fbB, false);
  applyMasterBrightness(ppu.fbB, ppu.masterBrightB);
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
// Per-scanline mask: low 6 bits = (BG0..BG3, OBJ, special-effect) enable
// bits for the window region that covers this pixel. Filled fresh for
// each scanline once windows are computed.
const windowMaskLine = new Uint8Array(BG_LINE_W);

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
  const bgVramBase  = isEngineA
    ? resolveVramBase(0x06000000, FALLBACK_ENGINE_A_BG)
    : resolveVramBase(0x06200000, FALLBACK_ENGINE_B_BG);
  const objVramBase = isEngineA
    ? resolveVramBase(0x06400000, FALLBACK_ENGINE_A_OBJ)
    : resolveVramBase(0x06600000, FALLBACK_ENGINE_B_OBJ);
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

  // Window state for this engine. windowsEnabled = any of WIN0/WIN1/
  // OBJWIN are active per DISPCNT bits 13/14/15. When none are on, we
  // skip per-pixel masking entirely.
  const dispcntWin = (dispcnt >>> 13) & 0x7;
  const windowsEnabled = dispcntWin !== 0;
  const win0Enabled = (dispcntWin & 0x1) !== 0;
  const win1Enabled = (dispcntWin & 0x2) !== 0;
  const objWinEnabled = (dispcntWin & 0x4) !== 0;
  const winH = isEngineA ? ppu.winHA : ppu.winHB;
  const winV = isEngineA ? ppu.winVA : ppu.winVB;
  const winIn  = isEngineA ? ppu.winInA  : ppu.winInB;
  const winOut = isEngineA ? ppu.winOutA : ppu.winOutB;

  // Color-special-effects state.
  const bldCnt   = isEngineA ? ppu.bldCntA   : ppu.bldCntB;
  const bldAlpha = isEngineA ? ppu.bldAlphaA : ppu.bldAlphaB;
  const bldY     = isEngineA ? ppu.bldYA     : ppu.bldYB;
  const effectMode = (bldCnt >>> 6) & 0x3;
  const targetA = bldCnt & 0x3F;
  const targetB = (bldCnt >>> 8) & 0x3F;
  const eva = Math.min(16, bldAlpha & 0x1F);
  const evb = Math.min(16, (bldAlpha >>> 8) & 0x1F);
  const evy = Math.min(16, bldY & 0x1F);

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

    // Build the per-pixel window mask for this scanline if any window
    // is active. The mask's low 6 bits are (BG0..BG3, OBJ, special-fx).
    if (windowsEnabled) {
      buildWindowMaskLine(windowMaskLine, y, win0Enabled, win1Enabled,
                          objWinEnabled, winH, winV, winIn, winOut, objLineCache);
    }

    // Per-pixel priority compositing. Each BG has a priority from its
    // BGxCNT.bits 0:1. OBJ priority comes from each sprite (highest
    // wins among overlapping sprites per pixel — already resolved in
    // objLineCache).
    const rowOff = y * SCREEN_W * 4;
    for (let x = 0; x < SCREEN_W; x++) {
      const mask = windowsEnabled ? windowMaskLine[x] : 0x3F;

      // Find the top-two visible layers by priority. Order BGs by
      // priority; ties broken by BG index (BG0 highest). OBJ sits at
      // its own priority and beats equal-priority BGs.
      let topColor = backdrop;
      let topLayer = LAYER_BACKDROP;
      let topPri = 5;
      let secondColor = backdrop;
      let secondLayer = LAYER_BACKDROP;
      let secondPri = 5;

      for (let bg = 0; bg < 4; bg++) {
        const v = bgLines[bg][x];
        if ((v & 0x8000) === 0) continue;
        if ((mask & (1 << bg)) === 0) continue;
        const pri = bgCnt[bg] & 0x3;
        const color = v & 0x7FFF;
        if (pri < topPri) {
          secondColor = topColor; secondLayer = topLayer; secondPri = topPri;
          topColor = color;       topLayer = bg;          topPri = pri;
        } else if (pri < secondPri) {
          secondColor = color; secondLayer = bg; secondPri = pri;
        }
      }
      const obj = objLineCache[x];
      const objVisible = obj.color !== 0 && (mask & (1 << LAYER_OBJ)) !== 0;
      if (objVisible) {
        // OBJ wins ties against BGs at equal priority (per GBATEK
        // §"OBJ Priority"). Use <= when comparing against the current
        // top, and < when comparing against the demoted-second so OBJ
        // doesn't displace a same-priority BG already in second slot.
        if (obj.priority <= topPri) {
          secondColor = topColor; secondLayer = topLayer; secondPri = topPri;
          topColor = obj.color;   topLayer = LAYER_OBJ;   topPri = obj.priority;
        } else if (obj.priority < secondPri) {
          secondColor = obj.color; secondLayer = LAYER_OBJ; secondPri = obj.priority;
        }
      }

      // Color special effect. Semi-transparent sprites force alpha
      // blending even when bldCnt mode is 0 — the OBJ becomes target A
      // and the underlying pixel target B. (GBATEK §"DS Color Special
      // Effects".) Special-effect bit in the window mask gates whether
      // any blend can run at this pixel.
      const sfxAllowed = (mask & (1 << LAYER_BACKDROP)) !== 0;     // bit 5 = "special-effect inside window"
      let finalColor = topColor;
      if (sfxAllowed) {
        const semiObjOnTop = topLayer === LAYER_OBJ && obj.semitransparent;
        if (semiObjOnTop && (targetB & (1 << secondLayer)) !== 0) {
          finalColor = alphaBlend(topColor, secondColor, eva, evb);
        } else if (effectMode === 1) {
          if ((targetA & (1 << topLayer)) !== 0 && (targetB & (1 << secondLayer)) !== 0) {
            finalColor = alphaBlend(topColor, secondColor, eva, evb);
          }
        } else if (effectMode === 2) {
          if ((targetA & (1 << topLayer)) !== 0) finalColor = fadeWhite(topColor, evy);
        } else if (effectMode === 3) {
          if ((targetA & (1 << topLayer)) !== 0) finalColor = fadeBlack(topColor, evy);
        }
      }

      writePixelAt(fb, rowOff + x * 4, finalColor);
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

// Window mask construction. WIN0 has highest priority, then WIN1, then
// OBJWIN (any pixel covered by an OBJ-window sprite), else OUTSIDE.
// Each region carries its own 6-bit mask (low nibble = BG0..3 enable,
// bit 4 = OBJ enable, bit 5 = special-effect enable).
function buildWindowMaskLine(
  out: Uint8Array,
  y: number,
  win0Enabled: boolean,
  win1Enabled: boolean,
  objWinEnabled: boolean,
  winH: Uint16Array,
  winV: Uint16Array,
  winIn: number,
  winOut: number,
  objLine: ReturnType<typeof newObjLine>,
): void {
  // Per GBATEK the right / bottom coordinates are exclusive; a region
  // with left==right is considered empty. Top/bottom wrap when bottom <
  // top (the region runs from top..bottom wrapping past line 191).
  const win0In  = winIn  & 0x3F;
  const win1In  = (winIn  >>> 8) & 0x3F;
  const objWinIn = (winOut >>> 8) & 0x3F;
  const outMask = winOut & 0x3F;

  const win0Row = win0Enabled && rowInsideWindow(y, winV[0]);
  const win1Row = win1Enabled && rowInsideWindow(y, winV[1]);

  const win0Right = winH[0] & 0xFF;
  const win0Left  = (winH[0] >>> 8) & 0xFF;
  const win1Right = winH[1] & 0xFF;
  const win1Left  = (winH[1] >>> 8) & 0xFF;

  for (let x = 0; x < BG_LINE_W; x++) {
    let mask = outMask;
    if (win0Row && colInsideWindow(x, win0Left, win0Right)) {
      mask = win0In;
    } else if (win1Row && colInsideWindow(x, win1Left, win1Right)) {
      mask = win1In;
    } else if (objWinEnabled && isObjWindowPixel(objLine, x)) {
      mask = objWinIn;
    }
    out[x] = mask;
  }
}

// OBJ-window sprites aren't yet flagged by sprites.ts (extended-OAM
// work is in a parallel agent). When that lands the OBJ samples will
// carry a "this pixel marks a window region only, doesn't draw" tag;
// this helper is the hook for that future signal. For now it always
// returns false so OBJWIN regions match nothing.
function isObjWindowPixel(_objLine: ReturnType<typeof newObjLine>, _x: number): boolean {
  return false;
}

function rowInsideWindow(y: number, vReg: number): boolean {
  const bottom = vReg & 0xFF;
  const top = (vReg >>> 8) & 0xFF;
  if (top <= bottom) return y >= top && y < bottom;
  // Wrapped region: top > bottom → runs top..255, 0..bottom.
  return y >= top || y < bottom;
}

function colInsideWindow(x: number, left: number, right: number): boolean {
  if (left <= right) return x >= left && x < right;
  return x >= left || x < right;
}

// Alpha-blend two BGR555 colors with weights EVA/EVB (each 0..16).
// Result clamped to 0..31 per channel.
function alphaBlend(a: number, b: number, eva: number, evb: number): number {
  const ar = a & 0x1F, ag = (a >>> 5) & 0x1F, ab = (a >>> 10) & 0x1F;
  const br = b & 0x1F, bg = (b >>> 5) & 0x1F, bb = (b >>> 10) & 0x1F;
  const r = Math.min(31, (ar * eva + br * evb) >> 4);
  const g = Math.min(31, (ag * eva + bg * evb) >> 4);
  const bl = Math.min(31, (ab * eva + bb * evb) >> 4);
  return (bl << 10) | (g << 5) | r;
}

// Fade pixel toward white. evy ∈ 0..16; pixel += (31 - pixel) * evy / 16.
function fadeWhite(c: number, evy: number): number {
  const r = c & 0x1F, g = (c >>> 5) & 0x1F, b = (c >>> 10) & 0x1F;
  const nr = r + (((31 - r) * evy) >> 4);
  const ng = g + (((31 - g) * evy) >> 4);
  const nb = b + (((31 - b) * evy) >> 4);
  return (nb << 10) | (ng << 5) | nr;
}

// Fade pixel toward black. evy ∈ 0..16; pixel -= pixel * evy / 16.
function fadeBlack(c: number, evy: number): number {
  const r = c & 0x1F, g = (c >>> 5) & 0x1F, b = (c >>> 10) & 0x1F;
  const nr = r - ((r * evy) >> 4);
  const ng = g - ((g * evy) >> 4);
  const nb = b - ((b * evy) >> 4);
  return (nb << 10) | (ng << 5) | nr;
}

// Final post-process: MASTER_BRIGHT shifts every pixel of fb toward
// white (mode 1) or black (mode 2) by factor/16. Mode 0 is a no-op,
// mode 3 is documented as "reserved" — we treat it as zero output to
// match real hardware ("output is forced to black").
function applyMasterBrightness(fb: Uint8ClampedArray, reg: number): void {
  const mode = (reg >>> 14) & 0x3;
  if (mode === 0) return;
  const factor = Math.min(16, reg & 0x1F);
  if (mode === 1) {
    if (factor === 0) return;
    for (let i = 0; i < fb.length; i += 4) {
      fb[i]     = fb[i]     + (((255 - fb[i])     * factor) >> 4);
      fb[i + 1] = fb[i + 1] + (((255 - fb[i + 1]) * factor) >> 4);
      fb[i + 2] = fb[i + 2] + (((255 - fb[i + 2]) * factor) >> 4);
    }
  } else if (mode === 2) {
    if (factor === 0) return;
    for (let i = 0; i < fb.length; i += 4) {
      fb[i]     = fb[i]     - ((fb[i]     * factor) >> 4);
      fb[i + 1] = fb[i + 1] - ((fb[i + 1] * factor) >> 4);
      fb[i + 2] = fb[i + 2] - ((fb[i + 2] * factor) >> 4);
    }
  } else {
    // Mode 3 is "reserved" — output is black on real hardware.
    for (let i = 0; i < fb.length; i += 4) {
      fb[i] = 0; fb[i + 1] = 0; fb[i + 2] = 0;
    }
  }
}

// Display capture (engine A only). Triggered when DISPCAPCNT bit 31 is
// set; the configured source pixels are written into the selected VRAM
// bank and bit 31 is cleared. We implement source-A = current frame
// (engine A composited output) for now; 3D-source-only and main-RAM
// FIFO source-B are stubbed to "current frame" + the captured pixel
// alone respectively, matching what most games observe in practice.
function applyDisplayCapture(ppu: Ppu): void {
  const cnt = ppu.dispCapCnt >>> 0;
  if ((cnt & 0x80000000) === 0) return;

  const eva = Math.min(16, cnt & 0x1F);
  const evb = Math.min(16, (cnt >>> 8) & 0x1F);
  const writeBank = (cnt >>> 16) & 0x3;       // 0=A,1=B,2=C,3=D
  const writeOff  = (cnt >>> 18) & 0x3;       // 32 KB block within bank
  const sizeSel   = (cnt >>> 20) & 0x3;       // 0=128x128,1=256x64,2=256x128,3=256x192
  const srcSelect = (cnt >>> 29) & 0x3;       // 0=A,1=B,2/3=blend

  let captureW = 256, captureH = 192;
  if (sizeSel === 0) { captureW = 128; captureH = 128; }
  else if (sizeSel === 1) { captureW = 256; captureH = 64; }
  else if (sizeSel === 2) { captureW = 256; captureH = 128; }

  // Destination: VRAM banks A..D each occupy 128 KB starting at offsets
  // 0, 0x20000, 0x40000, 0x60000 within ppu.mem.vram. The write-offset
  // selects which 32 KB sub-block to start in.
  const bankBase = writeBank * 0x20000;
  const dstBase = bankBase + writeOff * 0x8000;
  const vram = ppu.mem.vram;

  // Build "source A" line (current engine-A composited output) by
  // reverse-engineering bgr555 from the RGB framebuffer. Each captured
  // pixel is sourceA when srcSelect=0, sourceB when 1, or a blend when
  // 2/3. Source B = VRAM bank A (matching what real hardware uses when
  // capture bit 26 = 0) at the same offset; bit 26 = 1 ("main RAM
  // FIFO") is left as a no-op blend = sourceA only.
  const useMainFifoForB = (cnt & (1 << 26)) !== 0;

  for (let y = 0; y < captureH; y++) {
    for (let x = 0; x < captureW; x++) {
      const fbIdx = (y * SCREEN_W + x) * 4;
      const rA = ppu.fbA[fbIdx]     >> 3;
      const gA = ppu.fbA[fbIdx + 1] >> 3;
      const bA = ppu.fbA[fbIdx + 2] >> 3;
      const aA = ppu.fbA[fbIdx + 3] !== 0 ? 0x8000 : 0;
      const colA = aA | (bA << 10) | (gA << 5) | rA;

      let colB = 0;
      if (!useMainFifoForB) {
        // Source B = bank A at the same coordinate.
        const srcOff = (y * SCREEN_W + x) * 2;
        colB = vram[srcOff] | (vram[srcOff + 1] << 8);
      }

      let out: number;
      if (srcSelect === 0) {
        out = colA;
      } else if (srcSelect === 1) {
        out = colB;
      } else {
        // Blend per DISPCAPCNT EVA/EVB. Per GBATEK each component is
        // (A*EVA + B*EVB) / 16, clamped, with alpha = (aA | aB ? 0x8000 : 0).
        const aBit = ((colA | colB) & 0x8000) ? 0x8000 : 0;
        const ar = colA & 0x1F, ag = (colA >>> 5) & 0x1F, ab = (colA >>> 10) & 0x1F;
        const br = colB & 0x1F, bg = (colB >>> 5) & 0x1F, bb = (colB >>> 10) & 0x1F;
        const r = Math.min(31, (ar * eva + br * evb) >> 4);
        const g = Math.min(31, (ag * eva + bg * evb) >> 4);
        const b = Math.min(31, (ab * eva + bb * evb) >> 4);
        out = aBit | (b << 10) | (g << 5) | r;
      }

      const dstOff = dstBase + (y * captureW + x) * 2;
      if (dstOff + 1 < vram.length) {
        vram[dstOff]     = out & 0xFF;
        vram[dstOff + 1] = (out >>> 8) & 0xFF;
      }
    }
  }

  // Clear enable bit per GBATEK.
  ppu.dispCapCnt = cnt & 0x7FFFFFFF;
}
