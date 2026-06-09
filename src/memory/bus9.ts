// ARM9 view of the DS memory map. Routes reads/writes to the right
// backing block based on the top byte of the address. CP15-controlled
// TCMs are checked first (their address ranges are programmable) and
// otherwise we fall through to the standard map.
//
// Endianness: the DS is little-endian. All u16/u32 access here uses
// native byte order via DataView so we don't need shifts.

import { SharedMemory } from './shared';
import {
  MAIN_RAM_MASK,
  SHARED_WRAM_MASK,
  PRAM_BASE, PRAM_SIZE,
  OAM_BASE, OAM_SIZE,
  ITCM_SIZE, DTCM_SIZE,
} from './regions';
import type { IoBus } from '../io/io';
import type { VramRouter } from './vram_router';

export class Bus9 {
  mem: SharedMemory;
  io: IoBus | null = null;
  vram: VramRouter | null = null;
  // ITCM/DTCM are ARM9-private — fast on-die SRAM. CP15 control regs
  // pick the base + virtual size; physical size is fixed (16 KB DTCM,
  // 32 KB ITCM). When virtual > physical the TCM mirrors. Load-mode
  // bits (CP15 ctrl bits 17 / 19) cause reads to bypass the TCM and
  // fall through to whatever's below it, while writes still go to TCM.
  itcm = new Uint8Array(ITCM_SIZE);
  dtcm = new Uint8Array(DTCM_SIZE);
  itcmBase = 0x00000000;
  itcmVirtualSize = ITCM_SIZE;
  itcmEnabled = true;
  itcmLoadMode = false;
  dtcmBase = 0x027C0000;          // Nintendo's typical placement at end of main RAM.
  dtcmVirtualSize = DTCM_SIZE;
  dtcmEnabled = true;
  dtcmLoadMode = false;

  constructor(mem: SharedMemory) {
    this.mem = mem;
  }

  // Translate an address to (backing array, index). Returns null when
  // the access falls on a region we haven't implemented yet (IO ports
  // and VRAM bank routing) — the caller logs and returns 0.
  // `forWrite` matters for the TCM load-mode bits — in load mode, reads
  // from the TCM range fall through to the underlying memory but writes
  // still land in the TCM.
  private resolve(addr: number, forWrite: boolean): { arr: Uint8Array; idx: number } | null {
    addr = addr >>> 0;
    if (this.dtcmEnabled && addr >= this.dtcmBase && addr < this.dtcmBase + this.dtcmVirtualSize) {
      if (!this.dtcmLoadMode || forWrite) {
        return { arr: this.dtcm, idx: (addr - this.dtcmBase) & (DTCM_SIZE - 1) };
      }
      // Load mode + read: fall through to whatever maps this address
      // below DTCM (typically main RAM).
    }
    if (this.itcmEnabled && addr >= this.itcmBase && addr < this.itcmBase + this.itcmVirtualSize) {
      if (!this.itcmLoadMode || forWrite) {
        return { arr: this.itcm, idx: (addr - this.itcmBase) & (ITCM_SIZE - 1) };
      }
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
    // Shared WRAM block. WRAMCNT (ARM9-only writable) splits the 32 KB
    // shared block between ARM9 and ARM7 per GBATEK §"WRAMCNT":
    //   00: ARM9 sees all 32 KB
    //   01: ARM9 sees 2nd half (upper 16 KB at offset 0x4000)
    //   10: ARM9 sees 1st half (lower 16 KB at offset 0)
    //   11: ARM9 sees nothing (open bus / zero)
    if ((addr >>> 24) === 0x03) {
      const wcnt = this.mem.wramcnt & 0x3;
      if (wcnt === 0) return { arr: this.mem.sharedWram, idx: addr & SHARED_WRAM_MASK };
      if (wcnt === 1) return { arr: this.mem.sharedWram, idx: 0x4000 + (addr & 0x3FFF) }; // upper half
      if (wcnt === 2) return { arr: this.mem.sharedWram, idx: addr & 0x3FFF };            // lower half
      return null;
    }
    if (addr >= PRAM_BASE && addr < PRAM_BASE + PRAM_SIZE) {
      return { arr: this.mem.pram, idx: addr - PRAM_BASE };
    }
    // VRAM ranges (BG, OBJ, sub-BG, sub-OBJ, LCDC alias) all go through
    // the bank router which respects VRAMCNT_x mappings.
    if (addr >= 0x06000000 && addr < 0x07000000 && this.vram) {
      const idx = this.vram.resolveArm9(addr);
      if (idx >= 0) return { arr: this.mem.vram, idx };
      return null;
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
    const r = this.resolve(addr, false);
    return r ? r.arr[r.idx] : 0;
  }

  read16(addr: number): number {
    if (this.isIo(addr)) return this.io ? this.io.read16(addr) : 0;
    const r = this.resolve(addr, false);
    if (!r) return 0;
    return r.arr[r.idx] | (r.arr[r.idx + 1] << 8);
  }

  read32(addr: number): number {
    if (this.isIo(addr)) return this.io ? this.io.read32(addr) : 0;
    const r = this.resolve(addr, false);
    if (!r) return 0;
    return (r.arr[r.idx] | (r.arr[r.idx + 1] << 8) |
            (r.arr[r.idx + 2] << 16) | (r.arr[r.idx + 3] << 24)) >>> 0;
  }

  write8(addr: number, v: number): void {
    if (this.isIo(addr)) { this.io?.write8(addr, v); return; }
    const r = this.resolve(addr, true);
    if (r) r.arr[r.idx] = v & 0xFF;
  }

  write16(addr: number, v: number): void {
    if (this.isIo(addr)) { this.io?.write16(addr, v); return; }
    const r = this.resolve(addr, true);
    if (!r) return;
    r.arr[r.idx]     = v & 0xFF;
    r.arr[r.idx + 1] = (v >> 8) & 0xFF;
  }

  write32(addr: number, v: number): void {
    if (this.isIo(addr)) { this.io?.write32(addr, v); return; }
    const r = this.resolve(addr, true);
    if (!r) return;
    r.arr[r.idx]     = v & 0xFF;
    r.arr[r.idx + 1] = (v >> 8) & 0xFF;
    r.arr[r.idx + 2] = (v >> 16) & 0xFF;
    r.arr[r.idx + 3] = (v >> 24) & 0xFF;
  }
}
