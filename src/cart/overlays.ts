// NDS overlay loader. Pokemon Platinum (and most large DS games) split
// their ARM9 code across many overlay blobs stored in the cart's FAT
// instead of inlining everything in the boot ARM9 binary. The overlay
// table lives at header.arm9OverlayOffset and is an array of 32-byte
// descriptors; each names a destination address + size + a FAT index
// pointing at the actual bytes.
//
// On real hardware overlays are paged in via cart commands when the
// game's runtime needs them. We aren't modeling on-demand loading yet
// so we just preload them all at boot — that risks address collisions
// between overlays that share RAM windows, but it gets the game past
// the "BL to uninitialized RAM" failures it hits otherwise.

import { Bus9 } from '../memory/bus9';
import { Bus7 } from '../memory/bus7';
import type { SharedMemory } from '../memory/shared';
import { NdsHeader } from './header';
import { MAIN_RAM_MASK } from '../memory/regions';

const OVERLAY_INFO_SIZE = 32;
const FAT_ENTRY_SIZE    = 8;

interface OverlayInfo {
  overlayId: number;
  ramAddress: number;
  ramSize: number;
  bssSize: number;
  fileId: number;
}

function readOverlayInfo(rom: Uint8Array, offset: number): OverlayInfo {
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  return {
    overlayId:  dv.getUint32(offset + 0x00, true),
    ramAddress: dv.getUint32(offset + 0x04, true),
    ramSize:    dv.getUint32(offset + 0x08, true),
    bssSize:    dv.getUint32(offset + 0x0C, true),
    fileId:     dv.getUint32(offset + 0x18, true),
  };
}

function readFatEntry(rom: Uint8Array, fatBase: number, fileId: number): { start: number; end: number } {
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const off = fatBase + fileId * FAT_ENTRY_SIZE;
  return {
    start: dv.getUint32(off + 0, true),
    end:   dv.getUint32(off + 4, true),
  };
}

// Fast-path bulk copy from ROM into Main RAM (the only window overlays
// actually target). Slower paths fall through to byte-by-byte bus writes.
function copyOverlay(bus: Bus9 | Bus7, mem: SharedMemory, dest: number, rom: Uint8Array, src: number, size: number): number {
  const end = Math.min(src + size, rom.length);
  const len = end - src;
  if (len <= 0) return 0;
  if ((dest >>> 24) === 0x02 || (dest >>> 24) === 0x01) {
    const dst = dest & MAIN_RAM_MASK;
    mem.mainRam.set(rom.subarray(src, end), dst);
    return len;
  }
  for (let i = 0; i < len; i++) bus.write8(dest + i, rom[src + i]);
  return len;
}

function zeroBss(bus: Bus9 | Bus7, mem: SharedMemory, dest: number, size: number): void {
  if (size <= 0) return;
  if ((dest >>> 24) === 0x02 || (dest >>> 24) === 0x01) {
    const dst = dest & MAIN_RAM_MASK;
    mem.mainRam.fill(0, dst, dst + size);
    return;
  }
  for (let i = 0; i < size; i++) bus.write8(dest + i, 0);
}

export interface OverlayLoadStats {
  arm9Loaded: number;
  arm7Loaded: number;
  arm9Bytes: number;
  arm7Bytes: number;
  collisions: number;
}

export function loadAllOverlays(
  rom: Uint8Array,
  header: NdsHeader,
  bus9: Bus9,
  bus7: Bus7,
  mem: SharedMemory,
): OverlayLoadStats {
  const stats: OverlayLoadStats = { arm9Loaded: 0, arm7Loaded: 0, arm9Bytes: 0, arm7Bytes: 0, collisions: 0 };
  // ARM9 overlays.
  if (header.arm9OverlaySize >= OVERLAY_INFO_SIZE) {
    const count = (header.arm9OverlaySize / OVERLAY_INFO_SIZE) | 0;
    // Track byte ranges that are already covered by a previously-loaded
    // overlay so we don't stomp on it. Pokemon Platinum has 122 overlays
    // that share 17 RAM windows — only the first-loaded per window is
    // what the game wants resident at boot (and the static ARM9 binary
    // refers to it).
    const taken: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < count; i++) {
      const info = readOverlayInfo(rom, header.arm9OverlayOffset + i * OVERLAY_INFO_SIZE);
      const fat  = readFatEntry(rom, header.fatOffset, info.fileId);
      const srcLen = fat.end - fat.start;
      if (srcLen <= 0) continue;
      const start = info.ramAddress;
      const end = info.ramAddress + srcLen + info.bssSize;
      const overlaps = taken.some(r => !(end <= r.start || start >= r.end));
      if (overlaps) { stats.collisions++; continue; }
      taken.push({ start, end });
      stats.arm9Bytes += copyOverlay(bus9, mem, info.ramAddress, rom, fat.start, srcLen);
      zeroBss(bus9, mem, info.ramAddress + srcLen, info.bssSize);
      stats.arm9Loaded++;
    }
  }
  // ARM7 overlays (Pokemon Platinum has none, but other games use them).
  if (header.arm7OverlaySize >= OVERLAY_INFO_SIZE) {
    const count = (header.arm7OverlaySize / OVERLAY_INFO_SIZE) | 0;
    for (let i = 0; i < count; i++) {
      const info = readOverlayInfo(rom, header.arm7OverlayOffset + i * OVERLAY_INFO_SIZE);
      const fat  = readFatEntry(rom, header.fatOffset, info.fileId);
      const srcLen = fat.end - fat.start;
      if (srcLen <= 0) continue;
      stats.arm7Bytes += copyOverlay(bus7, mem, info.ramAddress, rom, fat.start, srcLen);
      zeroBss(bus7, mem, info.ramAddress + srcLen, info.bssSize);
      stats.arm7Loaded++;
    }
  }
  return stats;
}
