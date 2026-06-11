// Bus9 / Bus7 region routing tests. Each test pins a value in a known
// backing store via the shared-memory references and reads it via the
// bus to verify the right region was hit. We avoid IO ports (which need
// an attached IoBus) and VRAM (which needs an attached VRAM router).

import { describe, it, expect, beforeEach } from 'vitest';
import { Bus9 } from '../memory/bus9';
import { Bus7 } from '../memory/bus7';
import { SharedMemory } from '../memory/shared';

describe('Bus9 (ARM9) region routing', () => {
  let mem: SharedMemory;
  let bus: Bus9;
  beforeEach(() => {
    mem = new SharedMemory();
    bus = new Bus9(mem);
    // Disable TCMs so they don't shadow the BIOS / Main-RAM tests.
    bus.itcmEnabled = false;
    bus.dtcmEnabled = false;
  });

  it('reads from low BIOS region at 0x00000000', () => {
    mem.biosArm9[0x00] = 0x11;
    mem.biosArm9[0x01] = 0x22;
    mem.biosArm9[0x02] = 0x33;
    mem.biosArm9[0x03] = 0x44;
    expect(bus.read32(0x00000000)).toBe(0x44332211);
  });

  it('reads from high BIOS mirror at 0xFFFF0000', () => {
    mem.biosArm9[0x100] = 0xDE;
    mem.biosArm9[0x101] = 0xAD;
    expect(bus.read16(0xFFFF0100)).toBe(0xADDE);
  });

  it('Main RAM read / write at 0x02000000 round-trips', () => {
    bus.write32(0x02000000, 0xCAFEBABE);
    expect(bus.read32(0x02000000)).toBe(0xCAFEBABE);
    expect(mem.mainRam[0]).toBe(0xBE);
  });

  it('Main RAM mirror at 0x027xxxxx aliases the same physical store', () => {
    bus.write32(0x02000010, 0x11223344);
    // 0x027FFFFF & 0x3FFFFF = 0x3FFFFF — different physical addr.
    // But within the same 4 MB, 0x023xxxxx mirrors 0x02xxxxxx.
    expect(bus.read32(0x02400010 & ~0)).toBe(0x11223344);
    expect(bus.read32(0x02800010)).toBe(0x11223344);
  });

  it('Shared WRAM at 0x03000000 honors WRAMCNT=0 (ARM9 owns all)', () => {
    mem.wramcnt = 0;
    bus.write32(0x03000000, 0xCC00CC00);
    expect(mem.sharedWram[0]).toBe(0x00);
    expect(mem.sharedWram[1]).toBe(0xCC);
    expect(bus.read32(0x03000000)).toBe(0xCC00CC00);
  });

  it('WRAMCNT=3 makes the shared WRAM return 0 from ARM9 (open-bus)', () => {
    mem.wramcnt = 3;
    // Write goes nowhere observable.
    bus.write32(0x03000000, 0xBEEFCAFE);
    expect(bus.read32(0x03000000)).toBe(0);
  });

  it('PRAM at 0x05000000 round-trips', () => {
    bus.write32(0x05000000, 0xAA55AA55);
    expect(mem.pram[0]).toBe(0x55);
    expect(bus.read32(0x05000000)).toBe(0xAA55AA55);
  });

  it('OAM at 0x07000000 round-trips', () => {
    bus.write32(0x07000000, 0x12345678);
    expect(mem.oam[0]).toBe(0x78);
    expect(bus.read32(0x07000000)).toBe(0x12345678);
  });

  it('out-of-range read (e.g. 0x09000000) returns 0 instead of crashing', () => {
    expect(bus.read32(0x09000000)).toBe(0);
    expect(bus.read16(0x0F000000)).toBe(0);
    expect(bus.read8(0x80000000)).toBe(0);
    // Writes silently drop.
    expect(() => bus.write32(0x09000000, 0xDEADBEEF)).not.toThrow();
  });

  it('VRAM range 0x06000000 returns 0 when no router attached', () => {
    expect(bus.read32(0x06000000)).toBe(0);
    // Write doesn't throw either.
    expect(() => bus.write32(0x06000000, 0x1234)).not.toThrow();
  });
});

describe('Bus7 (ARM7) region routing', () => {
  let mem: SharedMemory;
  let bus: Bus7;
  beforeEach(() => {
    mem = new SharedMemory();
    bus = new Bus7(mem);
  });

  it('reads from ARM7 BIOS at 0x00000000', () => {
    mem.biosArm7[0x00] = 0xAA;
    mem.biosArm7[0x01] = 0xBB;
    expect(bus.read16(0x00000000)).toBe(0xBBAA);
  });

  it('Main RAM at 0x02000000 is the same physical block as ARM9', () => {
    mem.mainRam[0] = 0x42;
    expect(bus.read8(0x02000000)).toBe(0x42);
  });

  it('ARM7 IWRAM at 0x03800000 is private', () => {
    bus.write32(0x03800000, 0xABCD1234);
    expect(mem.arm7Iwram[0]).toBe(0x34);
    expect(bus.read32(0x03800000)).toBe(0xABCD1234);
  });

  it('WRAMCNT=3 (all-to-ARM7) gives ARM7 access to the full shared WRAM', () => {
    mem.wramcnt = 3;
    bus.write32(0x03000000, 0xFEEDFACE);
    // SHARED_WRAM_MASK = 0x7FFF (32 KB); 0x03000000 & mask = 0.
    expect(mem.sharedWram[0]).toBe(0xCE);
    expect(bus.read32(0x03000000)).toBe(0xFEEDFACE);
  });

  it('WRAMCNT=0 falls back to IWRAM mirror at 0x03000000 for ARM7', () => {
    mem.wramcnt = 0;
    bus.write32(0x03000000, 0xBABE);
    expect(mem.arm7Iwram[0]).toBe(0xBE);
  });

  it('out-of-range ARM7 read returns 0 (no crash)', () => {
    expect(bus.read32(0x09000000)).toBe(0);
    expect(bus.read8(0xF0000000)).toBe(0);
  });
});
