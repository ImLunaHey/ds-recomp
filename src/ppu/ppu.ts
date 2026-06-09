// Per-frame PPU scheduler. We don't render pixel-by-pixel yet — just
// count scanlines, raise VBlank IRQ at the right moment, and at the
// end of the visible area composite a 256×192 image for each engine.
// Real DS scanline timing: 355 dots/line × 263 lines/frame.
//
// The PPU exposes its state directly to the IoBus (DISPSTAT/VCOUNT).

import type { SharedMemory } from '../memory/shared';
import { Irq, IRQ_VBLANK, IRQ_HBLANK, IRQ_VCOUNT } from '../io/irq';
import { renderEngineA, renderEngineB } from './engine_a';
import type { Dma } from '../io/dma';

export const DOTS_PER_LINE  = 355;
export const LINES_PER_FRAME = 263;
export const VISIBLE_LINES  = 192;
export const SCREEN_W = 256;
export const SCREEN_H = 192;

export class Ppu {
  irq9: Irq;
  irq7: Irq;
  mem: SharedMemory;
  // DMAs are attached after construction (circular dep with Emulator).
  dma9: Dma | null = null;
  dma7: Dma | null = null;

  // DISPCNT for engines A and B (32-bit each).
  dispcntA = 0;
  dispcntB = 0;

  // BG layer control + scrolls for Engine A and B.
  bgCntA = new Uint16Array(4);
  bgHofsA = new Uint16Array(4);
  bgVofsA = new Uint16Array(4);
  bgCntB = new Uint16Array(4);
  bgHofsB = new Uint16Array(4);
  bgVofsB = new Uint16Array(4);

  // VRAMCNT_A..I — controls how each bank maps. The bus uses these via
  // VramRouter; the renderer also consults LCDC-direct mode when
  // DISPCNT display-mode 2 is selected.
  vramcnt = new Uint8Array(9);

  // MOSAIC register (engine A at 0x0400004C, engine B at 0x0400104C).
  // 4 nibbles: BG H size, BG V size, OBJ H size, OBJ V size (each "size"
  // is encoded as N-1 where N is the actual block width / height).
  mosaicA = 0;
  mosaicB = 0;

  // ARM7-side VRAMSTAT: bit 0 = bank C in ARM7 mode, bit 1 = bank D.
  vramStat(): number {
    let v = 0;
    if ((this.vramcnt[2] & 0x87) === 0x82) v |= 0x01;
    if ((this.vramcnt[3] & 0x87) === 0x82) v |= 0x02;
    return v;
  }

  // Compositor framebuffers in 0x00BBGGRR (Uint8) form, 256×192 RGBA.
  fbA = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);
  fbB = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);

  // Scanline state.
  cyclesAccum = 0;  // cycles into current line
  vcount = 0;
  dispstat = 0;     // bits: 0=VBlank, 1=HBlank, 2=VCount match, 8..15=VCount target
  frameCount = 0;
  frameDone = false;

  constructor(mem: SharedMemory, irq9: Irq, irq7: Irq) {
    this.mem = mem;
    this.irq9 = irq9;
    this.irq7 = irq7;
  }

  // Advance PPU by N ARM9 cycles. We share the same dot clock for
  // simplicity — every 1 ARM9 cycle = 1 dot. (Real hardware is 6
  // cycles/dot at 33 MHz ARM7, but for scheduling parity we model the
  // dot clock directly.)
  step(cycles: number): void {
    this.cyclesAccum += cycles;
    while (this.cyclesAccum >= DOTS_PER_LINE) {
      this.cyclesAccum -= DOTS_PER_LINE;
      this.endLine();
    }
    // HBlank flag mid-line, dot 256 onward.
    if (this.cyclesAccum >= 256) {
      if ((this.dispstat & 0x02) === 0) {
        this.dispstat |= 0x02;
        if (this.dispstat & 0x10) this.irq9.raise(IRQ_HBLANK);
      }
    } else {
      this.dispstat &= ~0x02;
    }
  }

  private endLine(): void {
    this.vcount = (this.vcount + 1) % LINES_PER_FRAME;
    if (this.vcount === VISIBLE_LINES) {
      this.dispstat |= 0x01;          // VBlank
      if (this.dispstat & 0x08) this.irq9.raise(IRQ_VBLANK);
      this.irq7.raise(IRQ_VBLANK);    // ARM7 typically wants this unconditionally
      this.dma9?.triggerVBlank();
      this.dma7?.triggerVBlank();
      renderEngineA(this);
      renderEngineB(this);
      this.frameCount++;
      this.frameDone = true;
    } else if (this.vcount === 0) {
      this.dispstat &= ~0x01;         // VBlank ends
    }
    // VCount match
    const target = (this.dispstat >>> 8) & 0xFF;
    if (this.vcount === target) {
      this.dispstat |= 0x04;
      if (this.dispstat & 0x20) this.irq9.raise(IRQ_VCOUNT);
    } else {
      this.dispstat &= ~0x04;
    }
  }
}
