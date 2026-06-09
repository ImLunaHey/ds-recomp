// CP15 system control coprocessor for the ARM9. The DS uses it to
// configure caches, the MPU (protection regions), and the TCMs. We keep
// a minimal model: handle the writes that the official boot code makes
// and update ITCM/DTCM base+size on bus9 when they're reconfigured.
//
// Real CP15 has dozens of registers. For now we just store everything
// in a flat map and route the TCM-control writes (CRn=9, opc2=1) to the
// bus so addresses move when the kernel re-maps them.

import type { Bus9 } from '../memory/bus9';
import type { SharedMemory } from '../memory/shared';
import type { Cpu } from './cpu';

export class Cp15 {
  bus9: Bus9;
  mem: SharedMemory;
  cpu: Cpu | null = null;       // attached after Cpu construction
  regs = new Map<number, number>();

  constructor(bus9: Bus9, mem: SharedMemory) {
    this.bus9 = bus9;
    this.mem = mem;
    this.regs.set(key(0, 0, 0, 0), 0x41059461);   // Main ID
    this.regs.set(key(0, 1, 0, 0), 0x0F0D2112);   // Cache type
    this.updateIrqHandlerPtrLiteral();
  }

  // The BIOS IRQ stub at 0x18 reads a literal at offset 0x34 holding
  // the ADDRESS of the user IRQ handler ptr. DS games store that ptr at
  // DTCM_END - 4, so the literal must move whenever CP15 relocates DTCM.
  private updateIrqHandlerPtrLiteral(): void {
    const dtcmEnd = (this.bus9.dtcmBase + this.bus9.dtcmVirtualSize) >>> 0;
    const ptrAddr = (dtcmEnd - 4) >>> 0;
    const bios = this.mem.biosArm9;
    bios[0x34] =  ptrAddr        & 0xFF;
    bios[0x35] = (ptrAddr >>  8) & 0xFF;
    bios[0x36] = (ptrAddr >> 16) & 0xFF;
    bios[0x37] = (ptrAddr >> 24) & 0xFF;
  }

  read(opc1: number, crn: number, crm: number, opc2: number): number {
    return this.regs.get(key(opc1, crn, crm, opc2)) ?? 0;
  }

  write(opc1: number, crn: number, crm: number, opc2: number, value: number): void {
    this.regs.set(key(opc1, crn, crm, opc2), value >>> 0);
    // CRn=7 CRm=0 opc2=4 → "Wait For Interrupt". ARM946E-S halts in
    // low-power state until an IRQ becomes pending (regardless of
    // CPSR.I). The wake leaves CPSR untouched. We model it by setting
    // the halted flag and counting on Cpu.step()'s halt-wake check.
    // Pokemon Platinum's ARM9 scheduler idle loop spins
    //   DisableIrq → MCR WFI → B back
    // with no CPSR.I clear. To avoid burning CPU cycles spinning that
    // loop forever, we ALSO unmask IRQs on WFI — the real BIOS does
    // this implicitly via the SPSR restore on the next IRQ return, but
    // because the spin never gets a chance to re-enable on its own,
    // mirroring the unmask here gets the IRQ to fire on the next wake.
    if (crn === 7 && crm === 0 && opc2 === 4) {
      const s = this.cpu?.state;
      if (s) {
        s.cpsr &= ~0x80;
        s.halted = true;
      }
    }
    // TCM region/size — CRn=9, CRm=1, opc2=0 (DTCM) or 1 (ITCM). Bits
    // 31:12 = base address, bits 5:1 = size code (virtual size =
    // 512 << code). Physical TCM size is fixed; when virtual > physical
    // the bus mirrors via (addr & (physical-1)).
    if (crn === 9 && crm === 1) {
      const base = value & 0xFFFFF000;
      const sizeCode = (value >>> 1) & 0x1F;
      const virtSize = 512 << sizeCode;
      if (opc2 === 0) {
        this.bus9.dtcmBase = base >>> 0;
        this.bus9.dtcmVirtualSize = virtSize;
        this.updateIrqHandlerPtrLiteral();
      } else if (opc2 === 1) {
        // ITCM ignores the base field on real hardware (it's always at
        // 0x00000000 from the CPU's perspective), but the size code
        // still matters.
        this.bus9.itcmBase = 0;
        this.bus9.itcmVirtualSize = virtSize;
      }
    }
    // Control register CRn=1, CRm=0, opc2=0. Bit 16/18 enable, bit
    // 17/19 = load mode for DTCM/ITCM respectively.
    if (crn === 1 && crm === 0 && opc2 === 0) {
      this.bus9.dtcmEnabled  = (value & (1 << 16)) !== 0;
      this.bus9.dtcmLoadMode = (value & (1 << 17)) !== 0;
      this.bus9.itcmEnabled  = (value & (1 << 18)) !== 0;
      this.bus9.itcmLoadMode = (value & (1 << 19)) !== 0;
    }
  }
}

function key(opc1: number, crn: number, crm: number, opc2: number): number {
  return (opc1 << 16) | (crn << 8) | (crm << 4) | opc2;
}
