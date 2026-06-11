// Direct unit tests for the DMA controller. We build a stub `ArmBus`
// backed by a flat Uint8Array so we can verify per-byte transfer
// behaviour without spinning up the full emulator.

import { describe, it, expect, beforeEach } from 'vitest';
import { Dma } from '../io/dma';
import {
  Irq,
  IRQ_DMA0, IRQ_DMA1, IRQ_DMA2, IRQ_DMA3,
  IRQ_TIMER0,
} from '../io/irq';
import type { ArmBus } from '../cpu/bus';

// Backing-store bus: every address indexes a single 4 MB byte array.
class MemBus implements ArmBus {
  buf = new Uint8Array(4 * 1024 * 1024);
  read8(a: number): number { return this.buf[a & 0x3FFFFF]; }
  read16(a: number): number { const i = a & 0x3FFFFF; return this.buf[i] | (this.buf[i + 1] << 8); }
  read32(a: number): number {
    const i = a & 0x3FFFFF;
    return (this.buf[i] | (this.buf[i + 1] << 8) | (this.buf[i + 2] << 16) | (this.buf[i + 3] << 24)) >>> 0;
  }
  write8(a: number, v: number): void { this.buf[a & 0x3FFFFF] = v & 0xFF; }
  write16(a: number, v: number): void {
    const i = a & 0x3FFFFF; this.buf[i] = v & 0xFF; this.buf[i + 1] = (v >>> 8) & 0xFF;
  }
  write32(a: number, v: number): void {
    const i = a & 0x3FFFFF;
    this.buf[i]     = v & 0xFF;
    this.buf[i + 1] = (v >>> 8) & 0xFF;
    this.buf[i + 2] = (v >>> 16) & 0xFF;
    this.buf[i + 3] = (v >>> 24) & 0xFF;
  }
}

// DMA register base (channel 0). ARM7 base is 0x040000B0 too.
const CH0_SRC = 0xB0;
const CH0_DST = 0xB4;
const CH0_CNT = 0xB8;
const CH_STRIDE = 0x0C;

// Encode the 32-bit DMACNT value. wordCount lives in the low 16 bits
// (for ARM7) / low 21 bits (for ARM9). For test purposes we keep it
// under 0xFFFF so both fit.
function encodeCnt(opts: {
  count: number;
  dstMode?: number;
  srcMode?: number;
  repeat?: boolean;
  word32?: boolean;
  timing?: number;
  irqOnDone?: boolean;
  enable?: boolean;
  isArm9?: boolean;
}): number {
  const timing = opts.timing ?? 0;
  const ctrl = (
    ((opts.dstMode ?? 0) << 5) |
    ((opts.srcMode ?? 0) << 7) |
    ((opts.repeat ? 1 : 0) << 9) |
    ((opts.word32 ? 1 : 0) << 10) |
    (opts.isArm9 ? (timing << 11) : (timing << 12)) |
    ((opts.irqOnDone ? 1 : 0) << 14) |
    ((opts.enable ? 1 : 0) << 15)
  ) & 0xFFFF;
  return ((ctrl << 16) | (opts.count & 0xFFFF)) >>> 0;
}

function makeDma(isArm9: boolean): { dma: Dma; bus: MemBus; irq: Irq } {
  const bus = new MemBus();
  const irq = new Irq();
  const dma = new Dma(bus, irq, isArm9);
  return { dma, bus, irq };
}

describe('DMA controller', () => {
  describe('immediate-mode transfers', () => {
    let bus: MemBus, dma: Dma;
    beforeEach(() => {
      const m = makeDma(true);
      bus = m.bus; dma = m.dma;
    });

    it('channel 0 immediate mode copies N words and clears the enable bit', () => {
      // Seed 8 32-bit words at src=0x100, then DMA to dst=0x200.
      for (let i = 0; i < 8; i++) bus.write32(0x100 + i * 4, 0xDEADBE00 + i);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({ count: 8, word32: true, enable: true, isArm9: true }));
      for (let i = 0; i < 8; i++) expect(bus.read32(0x200 + i * 4)).toBe((0xDEADBE00 + i) >>> 0);
      // Enable bit cleared after non-repeat completion.
      expect((dma.read32(CH0_CNT) >>> 31) & 1).toBe(0);
      expect(dma.channels[0].enabled).toBe(false);
    });

    it('halfword (16-bit) transfer moves count*2 bytes', () => {
      for (let i = 0; i < 4; i++) bus.write16(0x100 + i * 2, 0x1100 + i);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({ count: 4, word32: false, enable: true, isArm9: true }));
      for (let i = 0; i < 4; i++) expect(bus.read16(0x200 + i * 2)).toBe(0x1100 + i);
      // Should NOT have written a 5th halfword.
      expect(bus.read16(0x208)).toBe(0);
    });

    it('32-bit transfer moves count*4 bytes (word stride)', () => {
      for (let i = 0; i < 3; i++) bus.write32(0x100 + i * 4, 0xCAFE0000 + i);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x300);
      dma.write32(CH0_CNT, encodeCnt({ count: 3, word32: true, enable: true, isArm9: true }));
      for (let i = 0; i < 3; i++) expect(bus.read32(0x300 + i * 4)).toBe((0xCAFE0000 + i) >>> 0);
      // No word at +12.
      expect(bus.read32(0x30C)).toBe(0);
    });
  });

  describe('source-mode handling', () => {
    it('srcMode=0 (increment) advances source pointer through buffer', () => {
      const { bus, dma } = makeDma(true);
      for (let i = 0; i < 4; i++) bus.write32(0x100 + i * 4, 0xAA00 + i);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({ count: 4, word32: true, srcMode: 0, enable: true, isArm9: true }));
      for (let i = 0; i < 4; i++) expect(bus.read32(0x200 + i * 4)).toBe(0xAA00 + i);
    });

    it('srcMode=2 (fixed) reads the same source every iteration', () => {
      const { bus, dma } = makeDma(true);
      bus.write32(0x100, 0x55667788);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({ count: 4, word32: true, srcMode: 2, enable: true, isArm9: true }));
      for (let i = 0; i < 4; i++) expect(bus.read32(0x200 + i * 4)).toBe(0x55667788);
    });

    it('srcMode=1 (decrement) walks source pointer backwards', () => {
      const { bus, dma } = makeDma(true);
      // src will be read at 0x110, 0x10C, 0x108, 0x104.
      bus.write32(0x110, 0xA1);
      bus.write32(0x10C, 0xA2);
      bus.write32(0x108, 0xA3);
      bus.write32(0x104, 0xA4);
      dma.write32(CH0_SRC, 0x110);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({ count: 4, word32: true, srcMode: 1, enable: true, isArm9: true }));
      expect(bus.read32(0x200)).toBe(0xA1);
      expect(bus.read32(0x204)).toBe(0xA2);
      expect(bus.read32(0x208)).toBe(0xA3);
      expect(bus.read32(0x20C)).toBe(0xA4);
    });
  });

  describe('dest-mode handling', () => {
    it('dstMode=2 (fixed) writes all words to the same address', () => {
      const { bus, dma } = makeDma(true);
      for (let i = 0; i < 4; i++) bus.write32(0x100 + i * 4, 0xB000 + i);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({ count: 4, word32: true, dstMode: 2, enable: true, isArm9: true }));
      // Final value is the last written.
      expect(bus.read32(0x200)).toBe(0xB003);
      // No other dest words touched.
      expect(bus.read32(0x204)).toBe(0);
    });

    it('dstMode=3 (increment-reload) writes forward, then reloads dst to the latched start', () => {
      const { bus, dma } = makeDma(true);
      for (let i = 0; i < 4; i++) bus.write32(0x100 + i * 4, 0xC000 + i);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({ count: 4, word32: true, dstMode: 3, enable: true, isArm9: true }));
      // GBATEK: mode 3 walks dst forward DURING the transfer (same as
      // mode 0), then snaps back to the latched start AFTER the channel
      // finishes — that way the next repeat trigger refills the same
      // buffer from scratch. Each source word lands at its own slot:
      expect(bus.read32(0x200)).toBe(0xC000);
      expect(bus.read32(0x204)).toBe(0xC001);
      expect(bus.read32(0x208)).toBe(0xC002);
      expect(bus.read32(0x20C)).toBe(0xC003);
      // And the visible dst register is reloaded for the next round.
      expect(dma.channels[0].dst).toBe(0x200);
    });

    it('dstMode=1 (decrement) writes from high to low addresses', () => {
      const { bus, dma } = makeDma(true);
      for (let i = 0; i < 4; i++) bus.write32(0x100 + i * 4, 0xD000 + i);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x210);
      dma.write32(CH0_CNT, encodeCnt({ count: 4, word32: true, dstMode: 1, enable: true, isArm9: true }));
      expect(bus.read32(0x210)).toBe(0xD000);
      expect(bus.read32(0x20C)).toBe(0xD001);
      expect(bus.read32(0x208)).toBe(0xD002);
      expect(bus.read32(0x204)).toBe(0xD003);
    });
  });

  describe('timing modes', () => {
    it('VBlank-timed channel does not fire until triggerVBlank()', () => {
      const { bus, dma } = makeDma(true);
      bus.write32(0x100, 0xFEEDFACE);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({
        count: 1, word32: true, timing: 1, enable: true, isArm9: true,
      }));
      // Not fired yet.
      expect(bus.read32(0x200)).toBe(0);
      dma.triggerVBlank();
      expect(bus.read32(0x200)).toBe(0xFEEDFACE);
    });

    it('HBlank-timed channel only fires on triggerHBlank()', () => {
      const { bus, dma } = makeDma(true);
      bus.write32(0x100, 0xABCDEF01);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({
        count: 1, word32: true, timing: 2, enable: true, isArm9: true,
      }));
      expect(bus.read32(0x200)).toBe(0);
      dma.triggerVBlank();         // wrong trigger
      expect(bus.read32(0x200)).toBe(0);
      dma.triggerHBlank();
      expect(bus.read32(0x200)).toBe(0xABCDEF01);
    });

    it('CARDREADY-timed channel fires only on triggerCardReady() (ARM9)', () => {
      const { bus, dma } = makeDma(true);
      bus.write32(0x100, 0x11223344);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({
        count: 1, word32: true, timing: 5, enable: true, isArm9: true,
      }));
      expect(bus.read32(0x200)).toBe(0);
      dma.triggerCardReady();
      expect(bus.read32(0x200)).toBe(0x11223344);
    });

    it('triggerCardReady on ARM7 is a no-op', () => {
      const { bus, dma } = makeDma(false);
      bus.write32(0x100, 0x99887766);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      // ARM7 only has 2-bit timing; encode timing=3 (special) shouldn't
      // affect triggerCardReady which is ARM9-only.
      dma.write32(CH0_CNT, encodeCnt({
        count: 1, word32: true, timing: 3, enable: true, isArm9: false,
      }));
      dma.triggerCardReady();
      expect(bus.read32(0x200)).toBe(0);
    });
  });

  describe('repeat & IRQs', () => {
    it('repeat mode keeps the channel enabled across triggers', () => {
      const { bus, dma } = makeDma(true);
      bus.write32(0x100, 0xAAAA0001);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      // VBlank-triggered repeat.
      dma.write32(CH0_CNT, encodeCnt({
        count: 1, word32: true, timing: 1, repeat: true, enable: true, isArm9: true,
      }));
      dma.triggerVBlank();
      expect(bus.read32(0x200)).toBe(0xAAAA0001);
      expect(dma.channels[0].enabled).toBe(true);
      // After fire, src advanced by 4 (incr mode), dst advanced by 4. Seed
      // the new src and verify the next VBlank still transfers.
      bus.write32(0x104, 0xBBBB0002);
      dma.triggerVBlank();
      expect(bus.read32(0x204)).toBe(0xBBBB0002);
      expect(dma.channels[0].enabled).toBe(true);
    });

    it('IRQ-on-done raises the matching IRQ_DMA bit (regression: not IRQ_TIMER0)', () => {
      const { bus, dma, irq } = makeDma(true);
      bus.write32(0x100, 0x42);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({
        count: 1, word32: true, irqOnDone: true, enable: true, isArm9: true,
      }));
      expect(irq.if_ & IRQ_DMA0).toBe(IRQ_DMA0);
      // Critical: should NOT have set the timer bits which sit at lower
      // positions in IF.
      expect(irq.if_ & IRQ_TIMER0).toBe(0);
    });

    it('IRQ-on-done on channel 2 raises IRQ_DMA2, not DMA0/1/3', () => {
      const { bus, dma, irq } = makeDma(true);
      const off = CH_STRIDE * 2;
      bus.write32(0x100, 0x77);
      dma.write32(CH0_SRC + off, 0x100);
      dma.write32(CH0_DST + off, 0x200);
      dma.write32(CH0_CNT + off, encodeCnt({
        count: 1, word32: true, irqOnDone: true, enable: true, isArm9: true,
      }));
      expect(irq.if_ & IRQ_DMA2).toBe(IRQ_DMA2);
      expect(irq.if_ & IRQ_DMA0).toBe(0);
      expect(irq.if_ & IRQ_DMA1).toBe(0);
      expect(irq.if_ & IRQ_DMA3).toBe(0);
    });
  });

  describe('miscellaneous', () => {
    it('disabled channel does not transfer when its timing fires', () => {
      const { bus, dma } = makeDma(true);
      bus.write32(0x100, 0xDEAD);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      // Configured for VBlank but enable=false.
      dma.write32(CH0_CNT, encodeCnt({
        count: 1, word32: true, timing: 1, enable: false, isArm9: true,
      }));
      dma.triggerVBlank();
      expect(bus.read32(0x200)).toBe(0);
    });

    it('word32=false uses read16/write16 (high half of source ignored)', () => {
      const { bus, dma } = makeDma(true);
      // Seed a full word; halfword DMA should only copy 2 bytes.
      bus.write32(0x100, 0x11223344);
      dma.write32(CH0_SRC, 0x100);
      dma.write32(CH0_DST, 0x200);
      dma.write32(CH0_CNT, encodeCnt({
        count: 1, word32: false, enable: true, isArm9: true,
      }));
      // Only the low halfword at 0x200 written.
      expect(bus.read16(0x200)).toBe(0x3344);
      // Bytes 0x202..0x203 untouched.
      expect(bus.read16(0x202)).toBe(0);
    });
  });
});
