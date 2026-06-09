import { describe, it, expect, beforeEach } from 'vitest';
import { Bus9 } from '../memory/bus9';
import { SharedMemory } from '../memory/shared';

describe('Bus9 DTCM / ITCM', () => {
  let mem: SharedMemory;
  let bus: Bus9;

  beforeEach(() => {
    mem = new SharedMemory();
    bus = new Bus9(mem);
    bus.dtcmEnabled = true;
    bus.dtcmLoadMode = false;
    bus.itcmEnabled = true;
    bus.itcmLoadMode = false;
  });

  describe('DTCM mirroring (virtual > physical)', () => {
    it('plain 16 KB DTCM at 0x00800000 reads back what was written', () => {
      bus.dtcmBase = 0x00800000;
      bus.dtcmVirtualSize = 0x4000;
      bus.write32(0x00800000, 0x11223344);
      bus.write32(0x00803FFC, 0xAABBCCDD);
      expect(bus.read32(0x00800000)).toBe(0x11223344);
      expect(bus.read32(0x00803FFC)).toBe(0xAABBCCDD);
    });
    it('virtual size 32 KB mirrors physical 16 KB', () => {
      bus.dtcmBase = 0x00800000;
      bus.dtcmVirtualSize = 0x4000;
      bus.write32(0x00800000, 0x11223344);
      bus.write32(0x00803FFC, 0xAABBCCDD);
      // Move and double the virtual size.
      bus.dtcmBase = 0x00600000;
      bus.dtcmVirtualSize = 0x8000;
      expect(bus.read32(0x00604000)).toBe(0x11223344);
      expect(bus.read32(0x00607FFC)).toBe(0xAABBCCDD);
      expect(bus.read32(0x00600000)).toBe(0x11223344);
    });
  });

  describe('DTCM priority + load mode', () => {
    beforeEach(() => {
      mem.wramcnt = 0;
      bus.dtcmEnabled = false;
      bus.write32(0x03000000, 0xDEAD0001);
      bus.write32(0x03007FFC, 0xDEAD0002);
      bus.dtcmBase = 0x03000000;
      bus.dtcmVirtualSize = 0x8000;
      bus.dtcmEnabled = true;
    });
    it('DTCM beats shared WRAM at the same address', () => {
      bus.write32(0x03000000, 0xCAFEBABE);
      expect(bus.read32(0x03000000)).toBe(0xCAFEBABE);
    });
    it('load-mode read bypasses DTCM, write still hits DTCM', () => {
      bus.write32(0x03000000, 0xCAFEBABE);
      bus.dtcmLoadMode = true;
      expect(bus.read32(0x03000000)).toBe(0xDEAD0001);
      bus.write32(0x03000004, 0x12345678);
      bus.dtcmLoadMode = false;
      expect(bus.read32(0x03000004)).toBe(0x12345678);
    });
    it('disabling DTCM exposes the underlying WRAM', () => {
      bus.dtcmEnabled = false;
      expect(bus.read32(0x03000000)).toBe(0xDEAD0001);
      expect(bus.read32(0x03007FFC)).toBe(0xDEAD0002);
    });
  });

  describe('ITCM', () => {
    it('plain 32 KB ITCM read-back', () => {
      bus.itcmBase = 0;
      bus.itcmVirtualSize = 0x8000;
      bus.write32(0x00000000, 0x55555555);
      bus.write32(0x00007FFC, 0x77777777);
      expect(bus.read32(0x00000000)).toBe(0x55555555);
      expect(bus.read32(0x00007FFC)).toBe(0x77777777);
    });
    it('64 KB virtual mirrors 32 KB physical', () => {
      bus.itcmBase = 0;
      bus.itcmVirtualSize = 0x8000;
      bus.write32(0x00000000, 0x55555555);
      bus.write32(0x00007FFC, 0x77777777);
      bus.itcmVirtualSize = 0x10000;
      expect(bus.read32(0x00008000)).toBe(0x55555555);
      expect(bus.read32(0x0000FFFC)).toBe(0x77777777);
    });
  });
});
