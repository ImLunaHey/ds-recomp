// ROM loader edge cases. The loader memcpys the ARM9 and ARM7 binaries
// from the ROM image to their configured RAM addresses and stamps the
// BIOS-area state words. We verify that the bytes land at the right
// addresses and that ill-formed inputs throw a recognizable error
// rather than crashing.

import { describe, it, expect } from 'vitest';
import { loadNdsRom } from '../cart/loader';
import { parseNdsHeader, type NdsHeader } from '../cart/header';
import { Bus9 } from '../memory/bus9';
import { Bus7 } from '../memory/bus7';
import { SharedMemory } from '../memory/shared';

interface RomOpts {
  arm9RomOffset: number;
  arm9RamAddr: number;
  arm9Size: number;
  arm7RomOffset: number;
  arm7RamAddr: number;
  arm7Size: number;
  totalSize?: number;
}

function buildHeaderBytes(buf: Uint8Array, opts: RomOpts): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Title.
  const title = 'LOADERTEST';
  for (let i = 0; i < title.length; i++) buf[i] = title.charCodeAt(i);
  // Game code.
  const code = 'ZZZZ';
  for (let i = 0; i < 4; i++) buf[0x00C + i] = code.charCodeAt(i);
  buf[0x010] = 0x30; buf[0x011] = 0x31; // makerCode '01'
  dv.setUint32(0x020, opts.arm9RomOffset, true);
  dv.setUint32(0x024, opts.arm9RamAddr,   true);  // arm9 entry
  dv.setUint32(0x028, opts.arm9RamAddr,   true);  // arm9 ram addr
  dv.setUint32(0x02C, opts.arm9Size,      true);
  dv.setUint32(0x030, opts.arm7RomOffset, true);
  dv.setUint32(0x034, opts.arm7RamAddr,   true);  // arm7 entry
  dv.setUint32(0x038, opts.arm7RamAddr,   true);
  dv.setUint32(0x03C, opts.arm7Size,      true);
  dv.setUint32(0x080, opts.totalSize ?? buf.length, true);
}

function makeRom(opts: RomOpts): Uint8Array {
  const totalSize = opts.totalSize ?? Math.max(
    opts.arm9RomOffset + opts.arm9Size,
    opts.arm7RomOffset + opts.arm7Size,
  ) + 0x200;
  const rom = new Uint8Array(totalSize);
  buildHeaderBytes(rom, opts);
  // Fill the ARM9 block with a recognizable pattern.
  for (let i = 0; i < opts.arm9Size; i++) {
    rom[opts.arm9RomOffset + i] = 0xA0 + (i & 0x0F);
  }
  for (let i = 0; i < opts.arm7Size; i++) {
    rom[opts.arm7RomOffset + i] = 0x70 + (i & 0x0F);
  }
  return rom;
}

function makeBuses(): { bus9: Bus9; bus7: Bus7; mem: SharedMemory } {
  const mem = new SharedMemory();
  const bus9 = new Bus9(mem);
  const bus7 = new Bus7(mem);
  return { bus9, bus7, mem };
}

describe('ROM loader', () => {
  it('loads a synthetic ROM and places ARM9 bytes at the expected RAM address', () => {
    const opts: RomOpts = {
      arm9RomOffset: 0x4000, arm9RamAddr: 0x02000000, arm9Size: 0x100,
      arm7RomOffset: 0x5000, arm7RamAddr: 0x037F8000, arm7Size: 0x80,
    };
    const rom = makeRom(opts);
    const header: NdsHeader = parseNdsHeader(rom);
    const { bus9, bus7, mem } = makeBuses();
    const result = loadNdsRom(rom, header, bus9, bus7, mem);
    expect(result.arm9Bytes).toBe(0x100);
    // First ARM9 byte at 0x02000000.
    expect(mem.mainRam[0]).toBe(0xA0);
    expect(mem.mainRam[0x10]).toBe(0xA0);  // pattern repeats every 16
  });

  it('loads ARM7 binary into the ARM7 IWRAM region', () => {
    const opts: RomOpts = {
      arm9RomOffset: 0x4000, arm9RamAddr: 0x02000000, arm9Size: 0x80,
      // Place the ARM7 load address inside the dedicated IWRAM block at
      // 0x03800000 — the loader's bulkCopy fast-path memcopies straight
      // into mem.arm7Iwram for this region.
      arm7RomOffset: 0x5000, arm7RamAddr: 0x03800100, arm7Size: 0x80,
    };
    const rom = makeRom(opts);
    const header: NdsHeader = parseNdsHeader(rom);
    const { bus9, bus7, mem } = makeBuses();
    const result = loadNdsRom(rom, header, bus9, bus7, mem);
    expect(result.arm7Bytes).toBe(0x80);
    // 0x03800100 & ARM7_IWRAM_MASK (0xFFFF) = 0x100.
    expect(mem.arm7Iwram[0x100]).toBe(0x70);
    expect(mem.arm7Iwram[0x101]).toBe(0x71);
  });

  it('returns the entry points from the header', () => {
    const opts: RomOpts = {
      arm9RomOffset: 0x4000, arm9RamAddr: 0x02000800, arm9Size: 0x40,
      arm7RomOffset: 0x5000, arm7RamAddr: 0x037F8200, arm7Size: 0x40,
    };
    const rom = makeRom(opts);
    const header = parseNdsHeader(rom);
    const { bus9, bus7, mem } = makeBuses();
    const result = loadNdsRom(rom, header, bus9, bus7, mem);
    expect(result.arm9Entry).toBe(0x02000800);
    expect(result.arm7Entry).toBe(0x037F8200);
  });

  it('truncates copy when the ROM is shorter than header-claimed size (does not over-read)', () => {
    const opts: RomOpts = {
      arm9RomOffset: 0x4000, arm9RamAddr: 0x02000000, arm9Size: 0x10000,
      arm7RomOffset: 0x5000, arm7RamAddr: 0x037F8000, arm7Size: 0x80,
    };
    // Build a SMALL ROM whose declared sizes exceed what's actually
    // present; the loader caps to rom.length and reports the truncated
    // byte count.
    const rom = makeRom({ ...opts, totalSize: 0x4100 });
    const header = parseNdsHeader(rom);
    const { bus9, bus7, mem } = makeBuses();
    const result = loadNdsRom(rom, header, bus9, bus7, mem);
    // Only 0x100 ARM9 bytes were present after offset 0x4000.
    expect(result.arm9Bytes).toBe(0x100);
    // ARM7 ROM offset (0x5000) is BEYOND the ROM end → 0 bytes copied.
    expect(result.arm7Bytes).toBe(0);
  });

  it('malformed (too-small) ROM throws via parseNdsHeader before loader runs', () => {
    const tiny = new Uint8Array(100);
    expect(() => parseNdsHeader(tiny)).toThrow(/smaller than 512/);
  });
});
