// Direct unit tests for the BIOS HLE service routines. We construct a
// minimal Cpu + memory-backed bus and dispatch SWIs by setting R0..R3
// and calling `handleSwi(comment)`.

import { describe, it, expect, beforeEach } from 'vitest';
import { BiosHle } from '../bios/hle';
import { Cpu } from '../cpu/cpu';
import { Irq } from '../io/irq';
import type { ArmBus } from '../cpu/bus';

class MemBus implements ArmBus {
  buf = new Uint8Array(64 * 1024);
  read8(a: number): number { return this.buf[a & 0xFFFF]; }
  read16(a: number): number { const i = a & 0xFFFF; return this.buf[i] | (this.buf[i + 1] << 8); }
  read32(a: number): number {
    const i = a & 0xFFFF;
    return (this.buf[i] | (this.buf[i + 1] << 8) | (this.buf[i + 2] << 16) | (this.buf[i + 3] << 24)) >>> 0;
  }
  write8(a: number, v: number): void { this.buf[a & 0xFFFF] = v & 0xFF; }
  write16(a: number, v: number): void {
    const i = a & 0xFFFF; this.buf[i] = v & 0xFF; this.buf[i + 1] = (v >>> 8) & 0xFF;
  }
  write32(a: number, v: number): void {
    const i = a & 0xFFFF;
    this.buf[i]     = v & 0xFF;
    this.buf[i + 1] = (v >>> 8) & 0xFF;
    this.buf[i + 2] = (v >>> 16) & 0xFF;
    this.buf[i + 3] = (v >>> 24) & 0xFF;
  }
}

function make(): { bus: MemBus; cpu: Cpu; hle: BiosHle; irq: Irq } {
  const bus = new MemBus();
  const cpu = new Cpu(bus, true);
  const irq = new Irq();
  const hle = new BiosHle(cpu, irq);
  return { bus, cpu, hle, irq };
}

describe('BIOS HLE SWI handlers', () => {
  describe('Divide (SWI 0x09)', () => {
    let cpu: Cpu, hle: BiosHle;
    beforeEach(() => {
      const m = make();
      cpu = m.cpu; hle = m.hle;
    });
    it('signed divide 100/7 → quot=14, rem=2, |quot|=14', () => {
      cpu.state.r[0] = 100;
      cpu.state.r[1] = 7;
      hle.handleSwi(0x09);
      expect(cpu.state.r[0]).toBe(14);
      expect(cpu.state.r[1]).toBe(2);
      expect(cpu.state.r[3]).toBe(14);
    });
    it('signed divide negative result -100/7 → quot=-14, rem=-2, |quot|=14', () => {
      cpu.state.r[0] = -100 >>> 0;
      cpu.state.r[1] = 7;
      hle.handleSwi(0x09);
      expect(cpu.state.r[0] | 0).toBe(-14);
      expect(cpu.state.r[1] | 0).toBe(-2);
      expect(cpu.state.r[3]).toBe(14);
    });
    it('divide by zero: R0=+/-1 based on sign of numerator, R1=numerator, R3=|numerator|', () => {
      cpu.state.r[0] = 42;
      cpu.state.r[1] = 0;
      hle.handleSwi(0x09);
      expect(cpu.state.r[0]).toBe(1);
      expect(cpu.state.r[1]).toBe(42);
      expect(cpu.state.r[3]).toBe(42);
      // Negative numerator → R0 = 0xFFFFFFFF (= -1).
      cpu.state.r[0] = -7 >>> 0;
      cpu.state.r[1] = 0;
      hle.handleSwi(0x09);
      expect(cpu.state.r[0]).toBe(0xFFFFFFFF);
      expect(cpu.state.r[1]).toBe(-7 >>> 0);
      expect(cpu.state.r[3]).toBe(7);
    });
  });

  describe('CpuSet (SWI 0x0B)', () => {
    it('32-bit fixed source acts as a fill', () => {
      const { bus, cpu, hle } = make();
      bus.write32(0x100, 0xCAFEBABE);
      cpu.state.r[0] = 0x100;
      cpu.state.r[1] = 0x200;
      cpu.state.r[2] = 4 | (1 << 24) | (1 << 26);   // count=4, fixed, 32-bit
      hle.handleSwi(0x0B);
      for (let i = 0; i < 4; i++) {
        expect(bus.read32(0x200 + i * 4)).toBe(0xCAFEBABE);
      }
    });
    it('32-bit incrementing copy moves the source words', () => {
      const { bus, cpu, hle } = make();
      for (let i = 0; i < 4; i++) bus.write32(0x100 + i * 4, 0xAA00 + i);
      cpu.state.r[0] = 0x100;
      cpu.state.r[1] = 0x300;
      cpu.state.r[2] = 4 | (1 << 26);                // count=4, incrementing, 32-bit
      hle.handleSwi(0x0B);
      for (let i = 0; i < 4; i++) {
        expect(bus.read32(0x300 + i * 4)).toBe(0xAA00 + i);
      }
    });
    it('16-bit copy variant moves halfwords', () => {
      const { bus, cpu, hle } = make();
      for (let i = 0; i < 6; i++) bus.write16(0x100 + i * 2, 0xB000 + i);
      cpu.state.r[0] = 0x100;
      cpu.state.r[1] = 0x400;
      cpu.state.r[2] = 6;                            // count=6, 16-bit, increment
      hle.handleSwi(0x0B);
      for (let i = 0; i < 6; i++) {
        expect(bus.read16(0x400 + i * 2)).toBe(0xB000 + i);
      }
    });
  });

  describe('CpuFastSet (SWI 0x0C)', () => {
    it('32-bit copy advances src and dst by 4', () => {
      const { bus, cpu, hle } = make();
      for (let i = 0; i < 8; i++) bus.write32(0x100 + i * 4, 0xC100 + i);
      cpu.state.r[0] = 0x100;
      cpu.state.r[1] = 0x500;
      cpu.state.r[2] = 8;                            // count=8
      hle.handleSwi(0x0C);
      for (let i = 0; i < 8; i++) {
        expect(bus.read32(0x500 + i * 4)).toBe(0xC100 + i);
      }
    });
  });

  describe('BitUnPack (SWI 0x10)', () => {
    it('expands 1bpp to 8bpp with zero-fill on zero source bits', () => {
      const { bus, cpu, hle } = make();
      // Source = single byte 0b10110100. With 1bpp → 8bpp and dataOffset=0,
      // each '1' bit produces output value 1 (with zeroFlag=0, zeros stay
      // zero; '1' bits map to (1 + 0) & 0xFF = 1).
      bus.write8(0x100, 0b10110100);
      // Param block at 0x200: srcLen=1, srcWidth=1, dstWidth=8, dataOffset=0.
      bus.write16(0x200, 1);
      bus.write8(0x202, 1);
      bus.write8(0x203, 8);
      bus.write32(0x204, 0);
      cpu.state.r[0] = 0x100;
      cpu.state.r[1] = 0x300;
      cpu.state.r[2] = 0x200;
      hle.handleSwi(0x10);
      // Bits are read LSB-first (b shifts up): 0,0,1,0,1,1,0,1.
      const expected = [0, 0, 1, 0, 1, 1, 0, 1];
      for (let i = 0; i < 8; i++) {
        expect(bus.read8(0x300 + i)).toBe(expected[i]);
      }
    });
  });

  describe('LZ77UnComp (SWI 0x12)', () => {
    it('decompresses a trivial all-literals stream', () => {
      const { bus, cpu, hle } = make();
      // Build a tiny LZ77 input: header (type=0x10, size=4), one flag
      // byte with all zeros (4 literals), then 4 literal bytes.
      // Header = 0x10 (type) | (size << 8). size = 4.
      const header = 0x10 | (4 << 8);
      bus.write32(0x100, header);
      bus.write8(0x104, 0);                  // flag byte: all literal
      bus.write8(0x105, 0xAA);
      bus.write8(0x106, 0xBB);
      bus.write8(0x107, 0xCC);
      bus.write8(0x108, 0xDD);
      cpu.state.r[0] = 0x100;
      cpu.state.r[1] = 0x200;
      hle.handleSwi(0x12);
      expect(bus.read8(0x200)).toBe(0xAA);
      expect(bus.read8(0x201)).toBe(0xBB);
      expect(bus.read8(0x202)).toBe(0xCC);
      expect(bus.read8(0x203)).toBe(0xDD);
    });
    it('decompresses a stream containing a back-reference', () => {
      const { bus, cpu, hle } = make();
      // size = 6 bytes: write "ABAB" then back-ref last 2 bytes len=3 →
      // would extend further but we cap at size. Simplest: 2 literals
      // then a backref length 3, displacement 2 → re-reads last 2 bytes
      // repeating once and one more.
      // Header: type=0x10, size=5.
      bus.write32(0x100, 0x10 | (5 << 8));
      // Flag byte: 0b01000000 — bit 7 (=1) literal, bit 6 (=2 high) backref.
      // We read flags MSB-first: bit 7 first, then bit 6, etc.
      // We want: literal, literal, backref. So flags = 0b00100000.
      bus.write8(0x104, 0b00100000);
      bus.write8(0x105, 0x41);              // 'A'
      bus.write8(0x106, 0x42);              // 'B'
      // Backref: hi nibble = length-3, low 12 bits = disp-1.
      // length=3 → hi nibble = 0; disp=2 → 11-bit value 1 in low12.
      // Two bytes: hi (high nibble of hi), lo. We want disp=2 so encoded = 1.
      // hi byte = (length-3) << 4 | high nibble of (disp-1) = 0x00.
      // lo byte = low 8 bits of (disp-1) = 0x01.
      bus.write8(0x107, 0x00);
      bus.write8(0x108, 0x01);
      cpu.state.r[0] = 0x100;
      cpu.state.r[1] = 0x200;
      hle.handleSwi(0x12);
      // After: 'A','B', then backref disp=2 length=3 reads dst-2 three
      // times: A, B, A. Final: A,B,A,B,A.
      expect(bus.read8(0x200)).toBe(0x41);
      expect(bus.read8(0x201)).toBe(0x42);
      expect(bus.read8(0x202)).toBe(0x41);
      expect(bus.read8(0x203)).toBe(0x42);
      expect(bus.read8(0x204)).toBe(0x41);
    });
  });

  describe('GetCRC16 (SWI 0x0E)', () => {
    it('CRC of an empty buffer equals the initial value', () => {
      const { cpu, hle } = make();
      cpu.state.r[0] = 0xFFFF;
      cpu.state.r[1] = 0x100;
      cpu.state.r[2] = 0;
      hle.handleSwi(0x0E);
      expect(cpu.state.r[0]).toBe(0xFFFF);
    });
    it('CRC of a known byte sequence matches MODBUS / CRC-16/A001 reflected polynomial', () => {
      const { bus, cpu, hle } = make();
      const bytes = [0x01, 0x02, 0x03, 0x04];
      for (let i = 0; i < bytes.length; i++) bus.write8(0x100 + i, bytes[i]);
      cpu.state.r[0] = 0xFFFF;
      cpu.state.r[1] = 0x100;
      cpu.state.r[2] = bytes.length;
      hle.handleSwi(0x0E);
      // Compute reference CRC-16 with reflected poly 0xA001.
      let ref = 0xFFFF;
      for (const b of bytes) {
        ref ^= b;
        for (let i = 0; i < 8; i++) ref = (ref & 1) ? ((ref >>> 1) ^ 0xA001) : (ref >>> 1);
      }
      expect(cpu.state.r[0]).toBe(ref & 0xFFFF);
    });
  });
});
