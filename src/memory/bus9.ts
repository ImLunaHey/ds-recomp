// ARM9 view of the DS memory map. Routes reads/writes to the right
// backing block based on the top byte of the address. CP15-controlled
// TCMs are checked first (their address ranges are programmable) and
// otherwise we fall through to the standard map.
//
// Endianness: the DS is little-endian. All u16/u32 access here uses
// native byte order via DataView so we don't need shifts.

import { SharedMemory } from './shared';
import {
  MAIN_RAM_BASE, MAIN_RAM_MASK,
  SHARED_WRAM_BASE, SHARED_WRAM_MASK,
  PRAM_BASE, PRAM_SIZE,
  OAM_BASE, OAM_SIZE,
  VRAM_BASE, VRAM_TOTAL_SIZE,
  ITCM_SIZE, DTCM_SIZE,
} from './regions';
import type { IoBus } from '../io/io';

export class Bus9 {
  mem: SharedMemory;
  io: IoBus | null = null;
  // ITCM/DTCM are ARM9-private — fast on-die SRAM. CP15 control regs
  // pick the base + size; for now we keep the typical NDS defaults:
  // ITCM is mapped at 0x00000000–0x00007FFF (mirror up to the configured
  // size), DTCM is wherever the kernel programmed it.
  itcm = new Uint8Array(ITCM_SIZE);
  dtcm = new Uint8Array(DTCM_SIZE);
  itcmBase = 0x00000000;
  itcmMask = ITCM_SIZE - 1;
  itcmEnabled = true;
  dtcmBase = 0x027C0000;   // Nintendo's typical placement at end of main RAM.
  dtcmMask = DTCM_SIZE - 1;
  dtcmEnabled = true;

  constructor(mem: SharedMemory) {
    this.mem = mem;
  }

  // Translate an address to (backing array, index). Returns null when
  // the access falls on a region we haven't implemented yet (IO ports
  // and VRAM bank routing) — the caller logs and returns 0.
  private resolve(addr: number): { arr: Uint8Array; idx: number } | null {
    addr = addr >>> 0;
    if (this.dtcmEnabled && addr >= this.dtcmBase && addr < this.dtcmBase + DTCM_SIZE) {
      return { arr: this.dtcm, idx: (addr - this.dtcmBase) & this.dtcmMask };
    }
    if (this.itcmEnabled && addr >= this.itcmBase && addr < this.itcmBase + ITCM_SIZE) {
      return { arr: this.itcm, idx: (addr - this.itcmBase) & this.itcmMask };
    }
    // BIOS region (low + high vectors mirror).
    if (addr < 0x4000) {
      return { arr: this.mem.biosArm9, idx: addr };
    }
    if (addr >= 0xFFFF0000 && addr < 0xFFFF4000) {
      return { arr: this.mem.biosArm9, idx: addr - 0xFFFF0000 };
    }
    // Main RAM mirrors fill 0x02000000–0x02FFFFFF.
    // Pokemon Platinum (and other Nintendo SDK games) also rely on a
    // mirror at 0x01000000–0x01FFFFFF — they relocate the IRQ handler
    // there. GBATEK doesn't document that alias for retail DS but it
    // matches the CP15 protection region the game programs.
    if ((addr >>> 24) === 0x02 || (addr >>> 24) === 0x01) {
      return { arr: this.mem.mainRam, idx: addr & MAIN_RAM_MASK };
    }
    // Shared WRAM block — for now route all of 0x03xxxxxx here ignoring
    // the WRAMCNT split. We'll fix routing when WRAMCNT lands.
    if ((addr >>> 24) === 0x03) {
      return { arr: this.mem.sharedWram, idx: addr & SHARED_WRAM_MASK };
    }
    if (addr >= PRAM_BASE && addr < PRAM_BASE + PRAM_SIZE) {
      return { arr: this.mem.pram, idx: addr - PRAM_BASE };
    }
    if (addr >= VRAM_BASE && addr < VRAM_BASE + VRAM_TOTAL_SIZE) {
      return { arr: this.mem.vram, idx: addr - VRAM_BASE };
    }
    if (addr >= OAM_BASE && addr < OAM_BASE + OAM_SIZE) {
      return { arr: this.mem.oam, idx: addr - OAM_BASE };
    }
    return null;
  }

  attachIo(io: IoBus): void { this.io = io; }

  private isIo(addr: number): boolean { return (addr >>> 24) === 0x04; }

  read8(addr: number): number {
    if (this.isIo(addr)) return this.io ? this.io.read8(addr) : 0;
    const r = this.resolve(addr);
    return r ? r.arr[r.idx] : 0;
  }

  read16(addr: number): number {
    if (this.isIo(addr)) return this.io ? this.io.read16(addr) : 0;
    const r = this.resolve(addr);
    if (!r) return 0;
    return r.arr[r.idx] | (r.arr[r.idx + 1] << 8);
  }

  read32(addr: number): number {
    if (this.isIo(addr)) return this.io ? this.io.read32(addr) : 0;
    const r = this.resolve(addr);
    if (!r) return 0;
    return (r.arr[r.idx] | (r.arr[r.idx + 1] << 8) |
            (r.arr[r.idx + 2] << 16) | (r.arr[r.idx + 3] << 24)) >>> 0;
  }

  write8(addr: number, v: number): void {
    if (this.isIo(addr)) { this.io?.write8(addr, v); return; }
    const r = this.resolve(addr);
    if (r) r.arr[r.idx] = v & 0xFF;
  }

  write16(addr: number, v: number): void {
    if (this.isIo(addr)) { this.io?.write16(addr, v); return; }
    const r = this.resolve(addr);
    if (!r) return;
    r.arr[r.idx]     = v & 0xFF;
    r.arr[r.idx + 1] = (v >> 8) & 0xFF;
  }

  write32(addr: number, v: number): void {
    if (this.isIo(addr)) { this.io?.write32(addr, v); return; }
    const r = this.resolve(addr);
    if (!r) return;
    r.arr[r.idx]     = v & 0xFF;
    r.arr[r.idx + 1] = (v >> 8) & 0xFF;
    r.arr[r.idx + 2] = (v >> 16) & 0xFF;
    r.arr[r.idx + 3] = (v >> 24) & 0xFF;
  }
}
