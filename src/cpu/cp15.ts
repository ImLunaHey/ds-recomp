// CP15 system control coprocessor for the ARM9. The DS uses it to
// configure caches, the MPU (protection regions), and the TCMs. We keep
// a minimal model: handle the writes that the official boot code makes
// and update ITCM/DTCM base+size on bus9 when they're reconfigured.
//
// Real CP15 has dozens of registers. For now we just store everything
// in a flat map and route the TCM-control writes (CRn=9, opc2=1) to the
// bus so addresses move when the kernel re-maps them.

import type { Bus9 } from '../memory/bus9';
import { ITCM_SIZE, DTCM_SIZE } from '../memory/regions';
import type { SharedMemory } from '../memory/shared';

export class Cp15 {
  bus9: Bus9;
  mem: SharedMemory;
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
    const dtcmEnd = (this.bus9.dtcmBase + (this.bus9.dtcmMask + 1)) >>> 0;
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
    // TCM region/size — CRn=9, CRm=1, opc2=0 (DTCM) or 1 (ITCM).
    if (crn === 9 && crm === 1) {
      const base = value & 0xFFFFF000;
      const sizeCode = (value >>> 1) & 0x1F;
      const sizeBytes = 512 << sizeCode;
      if (opc2 === 0) {
        this.bus9.dtcmBase = base >>> 0;
        this.bus9.dtcmMask = (sizeBytes > DTCM_SIZE ? DTCM_SIZE : sizeBytes) - 1;
        this.updateIrqHandlerPtrLiteral();
      } else if (opc2 === 1) {
        this.bus9.itcmBase = base >>> 0;
        this.bus9.itcmMask = (sizeBytes > ITCM_SIZE ? ITCM_SIZE : sizeBytes) - 1;
      }
    }
    // Control register CRn=1, CRm=0, opc2=0 — bit 16 enables DTCM, 17 enables ITCM.
    if (crn === 1 && crm === 0 && opc2 === 0) {
      this.bus9.dtcmEnabled = (value & (1 << 16)) !== 0;
      this.bus9.itcmEnabled = (value & (1 << 18)) !== 0;
    }
  }
}

function key(opc1: number, crn: number, crm: number, opc2: number): number {
  return (opc1 << 16) | (crn << 8) | (crm << 4) | opc2;
}
