// ARM7 view of the DS memory map. The ARM7 sees Main RAM, the shared
// WRAM block (depending on WRAMCNT), its private 64 KB IWRAM at
// 0x03800000, and a separate IO + VRAM-WRAM window. It has no TCMs.

import { SharedMemory } from './shared';
import {
  MAIN_RAM_MASK,
  SHARED_WRAM_MASK,
  ARM7_IWRAM_MASK,
} from './regions';
import type { IoBus } from '../io/io';
import type { VramRouter } from './vram_router';

export class Bus7 {
  mem: SharedMemory;
  io: IoBus | null = null;
  vram: VramRouter | null = null;

  constructor(mem: SharedMemory) {
    this.mem = mem;
  }

  attachIo(io: IoBus): void { this.io = io; }
  private isIo(addr: number): boolean { return (addr >>> 24) === 0x04; }

  private resolve(addr: number): { arr: Uint8Array; idx: number } | null {
    addr = addr >>> 0;
    if (addr < 0x4000) {
      return { arr: this.mem.biosArm7, idx: addr };
    }
    if ((addr >>> 24) === 0x02) {
      return { arr: this.mem.mainRam, idx: addr & MAIN_RAM_MASK };
    }
    // ARM7-allocated VRAM banks (C or D with VRAMCNT_x.MST = 2).
    if (addr >= 0x06000000 && addr < 0x06040000 && this.vram) {
      const idx = this.vram.resolveArm7(addr);
      if (idx >= 0) return { arr: this.mem.vram, idx };
      return null;
    }
    if ((addr >>> 24) === 0x03) {
      // 0x03800000+ is always ARM7-private IWRAM (64 KB).
      if (addr >= 0x03800000) {
        return { arr: this.mem.arm7Iwram, idx: addr & ARM7_IWRAM_MASK };
      }
      // 0x03000000-0x037FFFFF is shared WRAM, gated by WRAMCNT. The
      // four ARM7-visible mappings (complementary to ARM9's):
      //   00: ARM7 sees nothing here — IWRAM mirror per GBATEK
      //   01: ARM7 sees upper 16 KB (offset 0x4000)
      //   10: ARM7 sees lower 16 KB (offset 0)
      //   11: ARM7 sees all 32 KB
      const wcnt = this.mem.wramcnt & 0x3;
      if (wcnt === 0) return { arr: this.mem.arm7Iwram, idx: addr & ARM7_IWRAM_MASK };
      if (wcnt === 1) return { arr: this.mem.sharedWram, idx: 0x4000 + (addr & 0x3FFF) };
      if (wcnt === 2) return { arr: this.mem.sharedWram, idx: addr & 0x3FFF };
      return { arr: this.mem.sharedWram, idx: addr & SHARED_WRAM_MASK };
    }
    return null;
  }

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
