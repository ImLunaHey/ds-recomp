// Overlay loader tests. Synthesizes a minimal NDS overlay table + FAT
// in a flat buffer, then drives loadAllOverlays() and verifies the
// requested bytes landed at the requested ramAddresses (via the
// SharedMemory main-RAM block) and the OverlayLoadStats came out
// with the expected counts.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllOverlays, type OverlayLoadStats } from '../cart/overlays';
import { Bus9 } from '../memory/bus9';
import { Bus7 } from '../memory/bus7';
import { SharedMemory } from '../memory/shared';
import type { NdsHeader } from '../cart/header';
import { MAIN_RAM_MASK } from '../memory/regions';

const OVERLAY_INFO_SIZE = 32;
const FAT_ENTRY_SIZE    = 8;

// Build a minimal valid header. Most fields default to 0 — we only
// need the overlay/FAT pointers and sizes for these tests.
function makeHeader(opts: Partial<NdsHeader> = {}): NdsHeader {
  return {
    title: '', gameCode: '', makerCode: '', unitCode: 0, romVersion: 0,
    capacityShift: 0, arm9RomOffset: 0, arm9EntryAddr: 0, arm9RamAddr: 0, arm9Size: 0,
    arm7RomOffset: 0, arm7EntryAddr: 0, arm7RamAddr: 0, arm7Size: 0,
    fntOffset: 0, fntSize: 0, fatOffset: 0, fatSize: 0,
    arm9OverlayOffset: 0, arm9OverlaySize: 0, arm7OverlayOffset: 0, arm7OverlaySize: 0,
    bannerOffset: 0, headerCrc: 0, totalUsedRomSize: 0,
    ...opts,
  };
}

interface SynthOverlay {
  overlayId: number;
  ramAddress: number;
  ramSize: number;
  bssSize: number;
  fileId: number;
  payload: Uint8Array;     // the actual bytes copied via the FAT entry
}

// Layout the ROM as:
//   [arm9TableOff..arm9TableOff+arm9TableSize)  — ARM9 overlay descriptors
//   [arm7TableOff..arm7TableOff+arm7TableSize)  — ARM7 overlay descriptors
//   [fatBase..fatBase+fatSize)                   — FAT entries (8 bytes each)
//   [payloadCursor..)                            — payload blobs
function buildRom(arm9Overlays: SynthOverlay[], arm7Overlays: SynthOverlay[] = []): {
  rom: Uint8Array;
  header: NdsHeader;
} {
  const allOverlays = [...arm9Overlays, ...arm7Overlays];
  const totalOverlays = allOverlays.length;
  const arm9TableSize = arm9Overlays.length * OVERLAY_INFO_SIZE;
  const arm7TableSize = arm7Overlays.length * OVERLAY_INFO_SIZE;
  const arm9TableOff = 0x1000;
  const arm7TableOff = arm9TableOff + arm9TableSize + 0x100;
  const fatBase = arm7TableOff + arm7TableSize + 0x100;
  // Maximum fileId across all overlays — that determines FAT size.
  const maxFileId = totalOverlays === 0 ? 0
    : Math.max(...allOverlays.map(o => o.fileId)) + 1;
  const fatSize = maxFileId * FAT_ENTRY_SIZE;
  let payloadCursor = fatBase + fatSize + 0x100;
  // Pre-compute payload offsets per overlay (by fileId).
  const fatRanges = new Map<number, { start: number; end: number }>();
  for (const o of allOverlays) {
    fatRanges.set(o.fileId, { start: payloadCursor, end: payloadCursor + o.payload.length });
    payloadCursor += o.payload.length + 0x10;
  }
  const rom = new Uint8Array(payloadCursor + 0x100);
  const dv = new DataView(rom.buffer);
  // Write ARM9 overlay descriptors.
  for (let i = 0; i < arm9Overlays.length; i++) {
    const o = arm9Overlays[i];
    const off = arm9TableOff + i * OVERLAY_INFO_SIZE;
    dv.setUint32(off + 0x00, o.overlayId, true);
    dv.setUint32(off + 0x04, o.ramAddress, true);
    dv.setUint32(off + 0x08, o.ramSize, true);
    dv.setUint32(off + 0x0C, o.bssSize, true);
    dv.setUint32(off + 0x18, o.fileId, true);
  }
  // Write ARM7 overlay descriptors.
  for (let i = 0; i < arm7Overlays.length; i++) {
    const o = arm7Overlays[i];
    const off = arm7TableOff + i * OVERLAY_INFO_SIZE;
    dv.setUint32(off + 0x00, o.overlayId, true);
    dv.setUint32(off + 0x04, o.ramAddress, true);
    dv.setUint32(off + 0x08, o.ramSize, true);
    dv.setUint32(off + 0x0C, o.bssSize, true);
    dv.setUint32(off + 0x18, o.fileId, true);
  }
  // Write FAT entries + payloads.
  for (const [fileId, range] of fatRanges) {
    const off = fatBase + fileId * FAT_ENTRY_SIZE;
    dv.setUint32(off + 0, range.start, true);
    dv.setUint32(off + 4, range.end, true);
  }
  for (const o of allOverlays) {
    const r = fatRanges.get(o.fileId)!;
    rom.set(o.payload, r.start);
  }
  const header = makeHeader({
    arm9OverlayOffset: arm9TableOff,
    arm9OverlaySize:   arm9TableSize,
    arm7OverlayOffset: arm7TableOff,
    arm7OverlaySize:   arm7TableSize,
    fatOffset: fatBase,
    fatSize,
  });
  return { rom, header };
}

function makeFixture(): { mem: SharedMemory; bus9: Bus9; bus7: Bus7 } {
  const mem = new SharedMemory();
  const bus9 = new Bus9(mem);
  const bus7 = new Bus7(mem);
  // Disable TCMs so writes to 0x02xxxxxx don't get shadowed.
  bus9.itcmEnabled = false;
  bus9.dtcmEnabled = false;
  return { mem, bus9, bus7 };
}

describe('overlays.loadAllOverlays — basic ARM9 two-entry load', () => {
  let mem: SharedMemory;
  let bus9: Bus9;
  let bus7: Bus7;
  beforeEach(() => { ({ mem, bus9, bus7 } = makeFixture()); });

  it('loads two non-overlapping ARM9 overlays into Main RAM at their ramAddresses', () => {
    const o0 = { overlayId: 0, ramAddress: 0x02100000, ramSize: 0x10, bssSize: 0, fileId: 0,
      payload: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22, 0x33, 0x44]) };
    const o1 = { overlayId: 1, ramAddress: 0x02200000, ramSize: 0x10, bssSize: 0, fileId: 1,
      payload: new Uint8Array([0x55, 0x66, 0x77, 0x88]) };
    const { rom, header } = buildRom([o0, o1]);
    const stats = loadAllOverlays(rom, header, bus9, bus7, mem);
    expect(stats.arm9Loaded).toBe(2);
    expect(stats.arm9Bytes).toBe(o0.payload.length + o1.payload.length);
    expect(stats.collisions).toBe(0);
    const off0 = o0.ramAddress & MAIN_RAM_MASK;
    const off1 = o1.ramAddress & MAIN_RAM_MASK;
    for (let i = 0; i < o0.payload.length; i++) {
      expect(mem.mainRam[off0 + i]).toBe(o0.payload[i]);
    }
    for (let i = 0; i < o1.payload.length; i++) {
      expect(mem.mainRam[off1 + i]).toBe(o1.payload[i]);
    }
  });

  it('honors the 32-byte OVERLAY_INFO_SIZE stride for entries 2..N', () => {
    // 3 overlays, each at a distinct ramAddress encoded into descriptor
    // 0, 1, and 2 of the table. If the stride is wrong, entries 1 / 2
    // will read garbage and not land at their declared addresses.
    const overlays = [
      { overlayId: 0, ramAddress: 0x02300000, ramSize: 4, bssSize: 0, fileId: 0,
        payload: new Uint8Array([0xAA, 0xAA, 0xAA, 0xAA]) },
      { overlayId: 1, ramAddress: 0x02310000, ramSize: 4, bssSize: 0, fileId: 1,
        payload: new Uint8Array([0xBB, 0xBB, 0xBB, 0xBB]) },
      { overlayId: 2, ramAddress: 0x02320000, ramSize: 4, bssSize: 0, fileId: 2,
        payload: new Uint8Array([0xCC, 0xCC, 0xCC, 0xCC]) },
    ];
    const { rom, header } = buildRom(overlays);
    const stats = loadAllOverlays(rom, header, bus9, bus7, mem);
    expect(stats.arm9Loaded).toBe(3);
    expect(mem.mainRam[0x300000]).toBe(0xAA);
    expect(mem.mainRam[0x310000]).toBe(0xBB);
    expect(mem.mainRam[0x320000]).toBe(0xCC);
  });
});

describe('overlays.loadAllOverlays — collision detection', () => {
  let mem: SharedMemory;
  let bus9: Bus9;
  let bus7: Bus7;
  beforeEach(() => { ({ mem, bus9, bus7 } = makeFixture()); });

  it('skips overlays that overlap a previously-loaded one and increments collisions', () => {
    // Two overlays at the SAME ramAddress: the second should be skipped,
    // counted as a collision, and the resident bytes should match the
    // FIRST overlay's payload.
    const o0 = { overlayId: 0, ramAddress: 0x02400000, ramSize: 0x10, bssSize: 0, fileId: 0,
      payload: new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]) };
    const o1 = { overlayId: 1, ramAddress: 0x02400000, ramSize: 0x10, bssSize: 0, fileId: 1,
      payload: new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]) };
    const { rom, header } = buildRom([o0, o1]);
    const stats = loadAllOverlays(rom, header, bus9, bus7, mem);
    expect(stats.arm9Loaded).toBe(1);
    expect(stats.collisions).toBe(1);
    // 0x02400000 lies in main RAM; mask to its physical offset.
    const off = 0x02400000 & MAIN_RAM_MASK;
    // The first overlay's first byte (0x11) must still be there.
    expect(mem.mainRam[off]).toBe(0x11);
    // The skipped overlay's first byte (0xAA) must NOT have overwritten.
    expect(mem.mainRam[off]).not.toBe(0xAA);
  });

  it('partially-overlapping ramAddress ranges also count as a collision', () => {
    // First overlay 16 bytes at 0x02500000; second overlay 16 bytes at
    // 0x02500008 (overlap of 8 bytes). Should be a collision.
    const o0 = { overlayId: 0, ramAddress: 0x02500000, ramSize: 0x10, bssSize: 0, fileId: 0,
      payload: new Uint8Array(16).fill(0xEE) };
    const o1 = { overlayId: 1, ramAddress: 0x02500008, ramSize: 0x10, bssSize: 0, fileId: 1,
      payload: new Uint8Array(16).fill(0xFF) };
    const { rom, header } = buildRom([o0, o1]);
    const stats = loadAllOverlays(rom, header, bus9, bus7, mem);
    expect(stats.arm9Loaded).toBe(1);
    expect(stats.collisions).toBe(1);
  });
});

describe('overlays.loadAllOverlays — byte counter tracking', () => {
  let mem: SharedMemory;
  let bus9: Bus9;
  let bus7: Bus7;
  beforeEach(() => { ({ mem, bus9, bus7 } = makeFixture()); });

  it('arm9Bytes and arm7Bytes track the totals of EACH side separately', () => {
    const arm9 = [
      { overlayId: 0, ramAddress: 0x02100000, ramSize: 32, bssSize: 0, fileId: 0,
        payload: new Uint8Array(20).fill(0x9A) },
    ];
    const arm7 = [
      { overlayId: 0, ramAddress: 0x02700000, ramSize: 32, bssSize: 0, fileId: 1,
        payload: new Uint8Array(7).fill(0x77) },
    ];
    const { rom, header } = buildRom(arm9, arm7);
    const stats = loadAllOverlays(rom, header, bus9, bus7, mem);
    expect(stats.arm9Loaded).toBe(1);
    expect(stats.arm7Loaded).toBe(1);
    expect(stats.arm9Bytes).toBe(20);
    expect(stats.arm7Bytes).toBe(7);
  });
});

describe('overlays.loadAllOverlays — truncated FAT tolerance', () => {
  let mem: SharedMemory;
  let bus9: Bus9;
  let bus7: Bus7;
  beforeEach(() => { ({ mem, bus9, bus7 } = makeFixture()); });

  it('FAT entry whose [start, end) lies past the ROM end is silently truncated', () => {
    // Build a normal overlay table, then patch the FAT entry to point
    // PAST the ROM. copyOverlay clamps to rom.length so it only copies
    // what's actually present — the test passes if no crash and the
    // loader continues processing other entries.
    const o0 = { overlayId: 0, ramAddress: 0x02100000, ramSize: 8, bssSize: 0, fileId: 0,
      payload: new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]) };
    const { rom, header } = buildRom([o0]);
    // Walk the FAT and rewrite entry 0 to point past end-of-rom.
    const dv = new DataView(rom.buffer);
    dv.setUint32(header.fatOffset + 0, rom.length + 0x1000, true);
    dv.setUint32(header.fatOffset + 4, rom.length + 0x2000, true);
    expect(() => loadAllOverlays(rom, header, bus9, bus7, mem)).not.toThrow();
  });
});

describe('overlays.loadAllOverlays — separate ARM7 / ARM9 routing', () => {
  let mem: SharedMemory;
  let bus9: Bus9;
  let bus7: Bus7;
  beforeEach(() => { ({ mem, bus9, bus7 } = makeFixture()); });

  it('ARM7 overlays and ARM9 overlays are loaded independently and counted separately', () => {
    const arm9 = [
      { overlayId: 0, ramAddress: 0x02100000, ramSize: 16, bssSize: 0, fileId: 0,
        payload: new Uint8Array(4).fill(0x91) },
      { overlayId: 1, ramAddress: 0x02110000, ramSize: 16, bssSize: 0, fileId: 1,
        payload: new Uint8Array(4).fill(0x92) },
    ];
    const arm7 = [
      { overlayId: 0, ramAddress: 0x02700000, ramSize: 16, bssSize: 0, fileId: 2,
        payload: new Uint8Array(4).fill(0x71) },
    ];
    const { rom, header } = buildRom(arm9, arm7);
    const stats = loadAllOverlays(rom, header, bus9, bus7, mem);
    expect(stats.arm9Loaded).toBe(2);
    expect(stats.arm7Loaded).toBe(1);
    // ARM9 bytes don't leak into the ARM7 counter and vice versa.
    expect(stats.arm9Bytes).toBe(8);
    expect(stats.arm7Bytes).toBe(4);
  });
});

describe('overlays.loadAllOverlays — empty-table handling', () => {
  let mem: SharedMemory;
  let bus9: Bus9;
  let bus7: Bus7;
  beforeEach(() => { ({ mem, bus9, bus7 } = makeFixture()); });

  it('arm9OverlayCount === 0 leaves stats at zero (and arm7 still processes)', () => {
    // Empty arm9 table + a single arm7 entry. The loader should skip
    // the arm9 loop and process the arm7 one.
    const arm7 = [
      { overlayId: 0, ramAddress: 0x02700000, ramSize: 8, bssSize: 0, fileId: 0,
        payload: new Uint8Array([0xC0, 0xDE]) },
    ];
    const { rom, header } = buildRom([], arm7);
    const stats = loadAllOverlays(rom, header, bus9, bus7, mem);
    expect(stats.arm9Loaded).toBe(0);
    expect(stats.arm9Bytes).toBe(0);
    expect(stats.collisions).toBe(0);
    expect(stats.arm7Loaded).toBe(1);
  });

  it('arm7OverlaySize < OVERLAY_INFO_SIZE (e.g. 0) leaves arm7 stats at zero', () => {
    const arm9 = [
      { overlayId: 0, ramAddress: 0x02100000, ramSize: 4, bssSize: 0, fileId: 0,
        payload: new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]) },
    ];
    const { rom, header } = buildRom(arm9);
    const stats = loadAllOverlays(rom, header, bus9, bus7, mem);
    expect(stats.arm7Loaded).toBe(0);
    expect(stats.arm7Bytes).toBe(0);
  });
});

describe('overlays.OverlayLoadStats — shape', () => {
  it('returned stats object has the documented shape', () => {
    const { mem, bus9, bus7 } = makeFixture();
    const { rom, header } = buildRom([]);
    const stats: OverlayLoadStats = loadAllOverlays(rom, header, bus9, bus7, mem);
    expect(stats).toHaveProperty('arm9Loaded');
    expect(stats).toHaveProperty('arm7Loaded');
    expect(stats).toHaveProperty('arm9Bytes');
    expect(stats).toHaveProperty('arm7Bytes');
    expect(stats).toHaveProperty('collisions');
    expect(typeof stats.arm9Loaded).toBe('number');
    expect(typeof stats.arm7Loaded).toBe('number');
    expect(typeof stats.arm9Bytes).toBe('number');
    expect(typeof stats.arm7Bytes).toBe('number');
    expect(typeof stats.collisions).toBe('number');
  });
});
