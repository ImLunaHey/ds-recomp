// CP15 system-control coprocessor unit tests. Drives the few control
// registers DS games actually touch (TCM relocation, WFI, control reg)
// and verifies the side-effects on the attached Bus9 / Cpu state.

import { describe, it, expect } from 'vitest';
import { Cp15 } from '../cpu/cp15';
import { Bus9 } from '../memory/bus9';
import { SharedMemory } from '../memory/shared';
import { Cpu } from '../cpu/cpu';
import { FLAG_I } from '../cpu/state';

function makeFixture(): { mem: SharedMemory; bus9: Bus9; cp15: Cp15; cpu: Cpu } {
  const mem = new SharedMemory();
  const bus9 = new Bus9(mem);
  const cpu = new Cpu(bus9, true);
  const cp15 = new Cp15(bus9, mem);
  cp15.cpu = cpu;
  return { mem, bus9, cp15, cpu };
}

describe('Cp15 — default-register reads', () => {
  it('read of an unregistered (opc1, crn, crm, opc2) returns 0', () => {
    const { cp15 } = makeFixture();
    expect(cp15.read(0, 2, 0, 0)).toBe(0);
    expect(cp15.read(0, 5, 0, 0)).toBe(0);
    expect(cp15.read(0, 9, 1, 0)).toBe(0);   // DTCM region read returns latched value (0 initially)
  });

  it('Main ID + Cache type are seeded at construction', () => {
    const { cp15 } = makeFixture();
    // Constructor sets these per the comment in cp15.ts:
    //   regs.set(key(0,0,0,0), 0x41059461)   — Main ID
    //   regs.set(key(0,1,0,0), 0x0F0D2112)   — Cache type
    expect(cp15.read(0, 0, 0, 0)).toBe(0x41059461);
    expect(cp15.read(0, 1, 0, 0)).toBe(0x0F0D2112);
  });
});

describe('Cp15 — IRQ handler pointer literal patching', () => {
  it('patches biosArm9[0x34..0x37] with (dtcmBase + dtcmVirtualSize - 4) LE', () => {
    const { mem, bus9, cp15 } = makeFixture();
    // After construction, the literal at 0x34 should equal
    // (dtcmBase + dtcmVirtualSize - 4) >>> 0 in little-endian.
    const expectedPtr = (bus9.dtcmBase + bus9.dtcmVirtualSize - 4) >>> 0;
    const b0 = mem.biosArm9[0x34];
    const b1 = mem.biosArm9[0x35];
    const b2 = mem.biosArm9[0x36];
    const b3 = mem.biosArm9[0x37];
    const read = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
    expect(read).toBe(expectedPtr);
    // Now relocate DTCM via the public helper and verify it updates.
    bus9.dtcmBase = 0x02FFC000;
    bus9.dtcmVirtualSize = 0x4000;
    cp15.updateIrqHandlerPtrLiteral();
    const newPtr = (0x02FFC000 + 0x4000 - 4) >>> 0;
    const b0b = mem.biosArm9[0x34];
    const b1b = mem.biosArm9[0x35];
    const b2b = mem.biosArm9[0x36];
    const b3b = mem.biosArm9[0x37];
    const readNew = (b0b | (b1b << 8) | (b2b << 16) | (b3b << 24)) >>> 0;
    expect(readNew).toBe(newPtr);
  });
});

describe('Cp15 — TCM region writes', () => {
  it('writing CRn=9 CRm=1 opc2=0 sets DTCM base + virtual size on bus9', () => {
    const { bus9, cp15 } = makeFixture();
    // Encode base=0x02FF0000, sizeCode=5 → virtSize = 512 << 5 = 16384.
    //   bits 31..12 = base, bits 5..1 = sizeCode.
    const sizeCode = 5;
    const value = (0x02FF0000 & 0xFFFFF000) | ((sizeCode & 0x1F) << 1);
    cp15.write(0, 9, 1, 0, value >>> 0);
    expect(bus9.dtcmBase).toBe(0x02FF0000);
    expect(bus9.dtcmVirtualSize).toBe(512 << sizeCode);
  });

  it('writing CRn=9 CRm=1 opc2=1 sets ITCM virtual size (base ignored, always 0)', () => {
    const { bus9, cp15 } = makeFixture();
    const sizeCode = 6;
    // Even with a non-zero base, ITCM base is forced to 0 by Cp15.
    const value = (0x00100000 & 0xFFFFF000) | ((sizeCode & 0x1F) << 1);
    cp15.write(0, 9, 1, 1, value >>> 0);
    expect(bus9.itcmBase).toBe(0);
    expect(bus9.itcmVirtualSize).toBe(512 << sizeCode);
  });
});

describe('Cp15 — Wait-For-Interrupt (CRn=7 CRm=0 opc2=4)', () => {
  it('sets cpu.state.halted and clears CPSR.I', () => {
    const { cpu, cp15 } = makeFixture();
    // Pre-set CPSR.I so we can confirm WFI clears it.
    cpu.state.cpsr |= FLAG_I;
    cpu.state.halted = false;
    cp15.write(0, 7, 0, 4, 0);
    expect(cpu.state.halted).toBe(true);
    expect((cpu.state.cpsr & FLAG_I) !== 0).toBe(false);
  });
});

describe('Cp15 — Control register (CRn=1 CRm=0 opc2=0)', () => {
  it('bit 16 = DTCM enable, bit 17 = DTCM load mode, bit 18 = ITCM enable, bit 19 = ITCM load mode', () => {
    const { bus9, cp15 } = makeFixture();
    // Start with everything disabled to make the write effect visible.
    bus9.dtcmEnabled = false; bus9.dtcmLoadMode = false;
    bus9.itcmEnabled = false; bus9.itcmLoadMode = false;
    // Write 1<<16 | 1<<18 = both TCMs enabled, load modes off.
    cp15.write(0, 1, 0, 0, (1 << 16) | (1 << 18));
    expect(bus9.dtcmEnabled).toBe(true);
    expect(bus9.itcmEnabled).toBe(true);
    expect(bus9.dtcmLoadMode).toBe(false);
    expect(bus9.itcmLoadMode).toBe(false);
    // Add load-mode bits.
    cp15.write(0, 1, 0, 0, (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19));
    expect(bus9.dtcmLoadMode).toBe(true);
    expect(bus9.itcmLoadMode).toBe(true);
    // Clear everything.
    cp15.write(0, 1, 0, 0, 0);
    expect(bus9.dtcmEnabled).toBe(false);
    expect(bus9.itcmEnabled).toBe(false);
    expect(bus9.dtcmLoadMode).toBe(false);
    expect(bus9.itcmLoadMode).toBe(false);
  });
});

describe('Cp15 — generic write/read round-trip', () => {
  it('stores arbitrary register writes and returns the value on read', () => {
    const { cp15 } = makeFixture();
    cp15.write(0, 5, 0, 0, 0xDEADBEEF);
    expect(cp15.read(0, 5, 0, 0)).toBe(0xDEADBEEF);
    // Different (opc1, crm, opc2) keys don't collide.
    cp15.write(0, 5, 0, 1, 0x12345678);
    expect(cp15.read(0, 5, 0, 0)).toBe(0xDEADBEEF);
    expect(cp15.read(0, 5, 0, 1)).toBe(0x12345678);
  });
});
