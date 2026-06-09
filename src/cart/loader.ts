// Copies the ARM9 and ARM7 binaries out of an NDS ROM image into their
// configured load addresses. On real hardware the cartridge protocol
// streams these blocks in over the encrypted KEY1 transfer; we just do
// a flat memcpy at boot since we're skipping the firmware/BIOS handoff.

import { Bus9 } from '../memory/bus9';
import { Bus7 } from '../memory/bus7';
import type { SharedMemory } from '../memory/shared';
import { NdsHeader } from './header';
import { MAIN_RAM_MASK, SHARED_WRAM_MASK, ARM7_IWRAM_MASK } from '../memory/regions';

export interface LoadResult {
  arm9Entry: number;
  arm7Entry: number;
  arm9Bytes: number;
  arm7Bytes: number;
}

// Bulk-copy a region of ROM straight into the backing block. Goes
// through the bus when the destination is IO/VRAM/PRAM (small writes
// are fine) and uses a direct subarray.set() for the common
// "binary lands in Main RAM / WRAM" case.
function bulkCopy(bus: Bus9 | Bus7, mem: SharedMemory, dest: number, rom: Uint8Array, offset: number, size: number): number {
  const end = Math.min(offset + size, rom.length);
  const len = end - offset;
  if (len <= 0) return 0;

  // Main RAM mirror — 0x02000000..0x02FFFFFF.
  if ((dest >>> 24) === 0x02) {
    const dst = (dest & MAIN_RAM_MASK) >>> 0;
    mem.mainRam.set(rom.subarray(offset, end), dst);
    return len;
  }
  // ARM7 IWRAM private region.
  if (dest >= 0x03800000 && dest < 0x03800000 + 0x10000) {
    const dst = (dest & ARM7_IWRAM_MASK) >>> 0;
    mem.arm7Iwram.set(rom.subarray(offset, end), dst);
    return len;
  }
  // Shared WRAM (covers 0x03000000..0x037FFFFF for both buses' default
  // route). Anything past the 32 KB block wraps because we mask.
  if (dest >= 0x03000000 && dest < 0x03800000) {
    const dst = (dest & SHARED_WRAM_MASK) >>> 0;
    mem.sharedWram.set(rom.subarray(offset, end), dst);
    return len;
  }

  // Fallback: byte-by-byte through the bus. Slow but always correct.
  for (let i = 0; i < len; i++) bus.write8(dest + i, rom[offset + i]);
  return len;
}

export function loadNdsRom(
  rom: Uint8Array,
  header: NdsHeader,
  bus9: Bus9,
  bus7: Bus7,
  mem: SharedMemory,
): LoadResult {
  const arm9Bytes = bulkCopy(bus9, mem, header.arm9RamAddr, rom, header.arm9RomOffset, header.arm9Size);
  const arm7Bytes = bulkCopy(bus7, mem, header.arm7RamAddr, rom, header.arm7RomOffset, header.arm7Size);

  return {
    arm9Entry: header.arm9EntryAddr,
    arm7Entry: header.arm7EntryAddr,
    arm9Bytes,
    arm7Bytes,
  };
}
