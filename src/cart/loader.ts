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

  // Per GBATEK § "BIOS RAM Usage", real DS firmware/BIOS leaves a block
  // of state in main RAM at 0x027FF800-0x027FFE00 before the game's
  // entry point runs. Without these values populated, many retail
  // games' SDK init code reads zeros and either deadlocks or crashes.
  //
  // Address values cross-referenced from guac's setBiosRam (BSD-3,
  // © 2025 Aaron Balke — see NOTICE), itself derived from GBATEK.
  //
  // Chip ID — use a Macronix-style ID encoding the ROM size, matching
  // what cart.ts's synthChipId computes for cmd 0x90 reads.
  const mb = rom.length / (1024 * 1024);
  let sizeByte: number;
  if (mb >= 128)      sizeByte = 0xFF;
  else if (mb >= 64)  sizeByte = 0xFD;
  else if (mb >= 32)  sizeByte = 0xFB;
  else if (mb >= 16)  sizeByte = 0xF7;
  else if (mb >= 8)   sizeByte = 0xEF;
  else if (mb >= 4)   sizeByte = 0xDF;
  else                sizeByte = 0xBF;
  const chipId = (((mb >= 128 ? 0x80 : 0x00) << 24) | (sizeByte << 8) | 0xC2) >>> 0;

  const w8 = (addr: number, v: number): void => { mem.mainRam[addr & MAIN_RAM_MASK] = v & 0xFF; };
  const w16 = (addr: number, v: number): void => { w8(addr, v); w8(addr + 1, v >> 8); };
  const w32 = (addr: number, v: number): void => { w16(addr, v); w16(addr + 2, v >> 16); };

  const cartHdrCrc = rom[0x15E] | (rom[0x15F] << 8);
  const cartSecCrc = rom[0x6C] | (rom[0x6D] << 8);

  // 0x027FF800 region — "first set" of BIOS-populated state.
  w32(0x027FF800, chipId);            // NDS Gamecart Chip ID 1
  w32(0x027FF804, chipId);            // NDS Gamecart Chip ID 2
  w16(0x027FF808, cartHdrCrc);        // Cart Header CRC
  w16(0x027FF80A, cartSecCrc);        // Cart Secure Area CRC
  w16(0x027FF810, 0xFFFF);            // Boot handler task (=FFFFh at cart boot)
  w16(0x027FF850, 0x5835);            // NDS7 BIOS CRC (well-known constant)
  w32(0x027FF880, 7);                 // Message NDS9→NDS7 (=7 at cart boot)
  w32(0x027FF884, 6);                 // NDS7 Boot Task (=6 at cart boot)

  // 0x027FFC00 region — "second set", mostly mirrors of the first.
  w32(0x027FFC00, chipId);            // copy of 0x027FF800
  w32(0x027FFC04, chipId);            // copy of 0x027FF804
  w16(0x027FFC08, cartHdrCrc);        // copy of 0x027FF808
  w16(0x027FFC0A, cartSecCrc);        // copy of 0x027FF80A
  w16(0x027FFC10, 0x5835);            // copy of 0x027FF850
  w16(0x027FFC40, 0x0001);            // Boot Indicator (1 = normal cart)

  // 0x027FFC80 — WiFi User Settings copy from firmware[0x3FE00..].
  // The loader doesn't hold a reference to the SPI module's firmware
  // blob; Emulator.loadRom() does the firmware-block copy here after
  // initFirmware() has stamped the user-settings layout.

  // 0x027FFE00 — first 0x170 bytes of cart header. Real DS firmware
  // copies this so the game's SDK can read its own header from a known
  // location without going through the cart interface. Earlier attempts
  // to populate this corrupted Pokemon Platinum's ARM7 stack — but with
  // the other RAM-state fixes also landing now, the SDK init that uses
  // this region has its own stack pointer properly set, so re-enabling.
  for (let i = 0; i < 0x170; i++) w8(0x027FFE00 + i, rom[i] ?? 0);

  return {
    arm9Entry: header.arm9EntryAddr,
    arm7Entry: header.arm7EntryAddr,
    arm9Bytes,
    arm7Bytes,
  };
}
