import { describe, it, expect, beforeEach } from 'vitest';
import { DsMath } from '../io/ds_math';

describe('DsMath', () => {
  let m: DsMath;
  beforeEach(() => { m = new DsMath(); });

  function writeNumer(lo: number, hi: number): void {
    m.write32(0x04000290, lo >>> 0);
    m.write32(0x04000294, hi >>> 0);
  }
  function writeDenom(lo: number, hi: number): void {
    m.write32(0x04000298, lo >>> 0);
    m.write32(0x0400029C, hi >>> 0);
  }
  function trigger(): void { m.write16(0x04000280, m.divcnt); }
  function readQuotLo(): number { return m.read32(0x040002A0); }
  function readRemLo(): number  { return m.read32(0x040002A8); }

  describe('Division', () => {
    it('32/32 signed positive: 100 / 3 = 33 rem 1', () => {
      m.divcnt = 0;
      writeNumer(100, 0); writeDenom(3, 0); trigger();
      expect(readQuotLo()).toBe(33);
      expect(readRemLo()).toBe(1);
    });

    it('32/32 signed negative: -7 / 2 = -3 rem -1', () => {
      m.divcnt = 0;
      writeNumer(-7 >>> 0, 0xFFFFFFFF);
      writeDenom(2, 0);
      trigger();
      expect(readQuotLo() | 0).toBe(-3);
      expect(readRemLo() | 0).toBe(-1);
    });

    it('div-by-zero sets DIVCNT bit 14', () => {
      m.divcnt = 0;
      writeNumer(42, 0); writeDenom(0, 0); trigger();
      expect((m.divcnt >> 14) & 1).toBe(1);
    });
  });

  describe('Square root', () => {
    it('sqrt(81) = 9', () => {
      m.sqrtcnt = 0;
      m.write32(0x040002B8, 81);
      m.write16(0x040002B0, 0);
      expect(m.read32(0x040002B4)).toBe(9);
    });
    it('sqrt(255) = 15 (floor)', () => {
      m.sqrtcnt = 0;
      m.write32(0x040002B8, 255);
      m.write16(0x040002B0, 0);
      expect(m.read32(0x040002B4)).toBe(15);
    });
    it('sqrt(2^60) = 2^30 in 64-bit mode', () => {
      m.sqrtcnt = 1;
      m.write32(0x040002B8, 0);
      m.write32(0x040002BC, 0x10000000);
      m.write16(0x040002B0, 1);
      expect(m.read32(0x040002B4) >>> 0).toBe(1073741824);
    });
  });
});
