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
import type { Wifi } from '../io/wifi';
import { WIFI_BASE, WIFI_END } from '../io/wifi';

export class Bus7 {
  mem: SharedMemory;
  io: IoBus | null = null;
  vram: VramRouter | null = null;
  wifi: Wifi | null = null;

  constructor(mem: SharedMemory) {
    this.mem = mem;
  }

  attachIo(io: IoBus): void { this.io = io; }
  attachWifi(wifi: Wifi): void { this.wifi = wifi; }
  // WiFi MMIO lives at 0x04800000-0x04807FFF, inside the larger IO
  // window (0x04xxxxxx). Detect it BEFORE the general IO dispatch so
  // the Wifi stub can shape the response — otherwise IoBus returns 0
  // for these unrelated addresses and games hang polling readiness.
  private isWifi(addr: number): boolean {
    return addr >= WIFI_BASE && addr < WIFI_END;
  }
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
      // four ARM7-visible mappings (complementary to ARM9's) per
      // GBATEK §"WRAMCNT":
      //   00: ARM7 sees nothing here — IWRAM mirror
      //   01: ARM7 sees 1st half (lower 16 KB at offset 0)
      //   10: ARM7 sees 2nd half (upper 16 KB at offset 0x4000)
      //   11: ARM7 sees all 32 KB
      const wcnt = this.mem.wramcnt & 0x3;
      if (wcnt === 0) return { arr: this.mem.arm7Iwram, idx: addr & ARM7_IWRAM_MASK };
      if (wcnt === 1) return { arr: this.mem.sharedWram, idx: addr & 0x3FFF };
      if (wcnt === 2) return { arr: this.mem.sharedWram, idx: 0x4000 + (addr & 0x3FFF) };
      return { arr: this.mem.sharedWram, idx: addr & SHARED_WRAM_MASK };
    }
    return null;
  }

  read8(addr: number): number {
    if (this.wifi && this.isWifi(addr)) return this.wifi.read8(addr);
    if (this.isIo(addr)) return this.io ? this.io.read8(addr) : 0;
    const r = this.resolve(addr);
    return r ? r.arr[r.idx] : 0;
  }

  read16(addr: number): number {
    if (this.wifi && this.isWifi(addr)) return this.wifi.read16(addr);
    if (this.isIo(addr)) return this.io ? this.io.read16(addr) : 0;
    const r = this.resolve(addr);
    if (!r) return 0;
    return r.arr[r.idx] | (r.arr[r.idx + 1] << 8);
  }

  read32(addr: number): number {
    if (this.wifi && this.isWifi(addr)) return this.wifi.read32(addr);
    if (this.isIo(addr)) return this.io ? this.io.read32(addr) : 0;
    const r = this.resolve(addr);
    if (!r) return 0;
    return (r.arr[r.idx] | (r.arr[r.idx + 1] << 8) |
            (r.arr[r.idx + 2] << 16) | (r.arr[r.idx + 3] << 24)) >>> 0;
  }

  write8(addr: number, v: number): void {
    if (this.wifi && this.isWifi(addr)) { this.wifi.write8(addr, v); return; }
    if (this.isIo(addr)) { this.io?.write8(addr, v); return; }
    const r = this.resolve(addr);
    if (r) r.arr[r.idx] = v & 0xFF;
  }

  write16(addr: number, v: number): void {
    if (this.wifi && this.isWifi(addr)) { this.wifi.write16(addr, v); return; }
    if (this.isIo(addr)) { this.io?.write16(addr, v); return; }
    const r = this.resolve(addr);
    if (!r) return;
    r.arr[r.idx]     = v & 0xFF;
    r.arr[r.idx + 1] = (v >> 8) & 0xFF;
  }

  write32(addr: number, v: number): void {
    if (this.wifi && this.isWifi(addr)) { this.wifi.write32(addr, v); return; }
    if (this.isIo(addr)) { this.io?.write32(addr, v); return; }
    // Nintendo SDK shared-OS-init-flags word at 0x027FFF8C. Real DS BIOS
    // sets some of these bits during the boot stub that runs before
    // ARM7's binary takes over (touchscreen ADC + RTC subsystem init).
    // We HLE the BIOS to bare minimum and don't run those subsystems,
    // so the corresponding bits are never set and games (NSMB,
    // Nintendogs, …) deadlock polling for them. Force-OR the missing
    // bit into every write so the boot-info word matches what BIOS
    // would have produced.
    // Bit 8 = touchscreen/RTC ready (NSMB, Nintendogs).
    // Bit 5 = sound subsystem ready (Tetris DS waits on this; confirmed
    // via AND-with-#0x20 polling loop at 0x0200A1E0).
    // Bit 0 = "BIOS boot completed" indicator various SDK code checks.
    if (addr === 0x027FFF8C) v |= 0x121;
    const r = this.resolve(addr);
    if (!r) return;
    r.arr[r.idx]     = v & 0xFF;
    r.arr[r.idx + 1] = (v >> 8) & 0xFF;
    r.arr[r.idx + 2] = (v >> 16) & 0xFF;
    r.arr[r.idx + 3] = (v >> 24) & 0xFF;
  }
}
