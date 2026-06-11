// NDS cartridge header parser tests. Builds a synthetic 512-byte
// header from scratch and verifies the parser pulls out the expected
// fields. We don't validate the CRC — the parser doesn't either.

import { describe, it, expect } from 'vitest';
import { parseNdsHeader, unitCodeName } from '../cart/header';

interface SynthOpts {
  title?: string;
  gameCode?: string;
  makerCode?: string;
  unitCode?: number;
  romVersion?: number;
  capacityShift?: number;
  arm9RomOffset?: number;
  arm9EntryAddr?: number;
  arm9RamAddr?: number;
  arm9Size?: number;
  arm7RomOffset?: number;
  arm7EntryAddr?: number;
  arm7RamAddr?: number;
  arm7Size?: number;
  fntOffset?: number;
  fntSize?: number;
  fatOffset?: number;
  fatSize?: number;
  bannerOffset?: number;
  headerCrc?: number;
  totalUsedRomSize?: number;
}

function buildHeader(opts: SynthOpts = {}): Uint8Array {
  const buf = new Uint8Array(0x200);
  const dv = new DataView(buf.buffer);
  const ascii = (off: number, s: string, len: number): void => {
    for (let i = 0; i < len; i++) buf[off + i] = i < s.length ? s.charCodeAt(i) : 0;
  };
  ascii(0x000, opts.title ?? 'TEST', 12);
  ascii(0x00C, opts.gameCode ?? 'ABCD', 4);
  ascii(0x010, opts.makerCode ?? '01', 2);
  buf[0x012] = opts.unitCode ?? 0;
  buf[0x014] = opts.capacityShift ?? 0;
  buf[0x01E] = opts.romVersion ?? 0;
  dv.setUint32(0x020, opts.arm9RomOffset ?? 0x4000,    true);
  dv.setUint32(0x024, opts.arm9EntryAddr ?? 0x02000000, true);
  dv.setUint32(0x028, opts.arm9RamAddr ?? 0x02000000,   true);
  dv.setUint32(0x02C, opts.arm9Size ?? 0x1000,          true);
  dv.setUint32(0x030, opts.arm7RomOffset ?? 0x5000,    true);
  dv.setUint32(0x034, opts.arm7EntryAddr ?? 0x037F8000, true);
  dv.setUint32(0x038, opts.arm7RamAddr ?? 0x037F8000,   true);
  dv.setUint32(0x03C, opts.arm7Size ?? 0x800,           true);
  dv.setUint32(0x040, opts.fntOffset ?? 0x6000,         true);
  dv.setUint32(0x044, opts.fntSize ?? 0x100,            true);
  dv.setUint32(0x048, opts.fatOffset ?? 0x7000,         true);
  dv.setUint32(0x04C, opts.fatSize ?? 0x200,            true);
  dv.setUint32(0x068, opts.bannerOffset ?? 0x8000,      true);
  dv.setUint32(0x080, opts.totalUsedRomSize ?? 0x10000, true);
  dv.setUint16(0x15E, opts.headerCrc ?? 0xCAFE,         true);
  return buf;
}

describe('NDS header parser', () => {
  it('parses a synthetic minimal header', () => {
    const rom = buildHeader({
      title: 'POKEMON',
      gameCode: 'CPUE',
      makerCode: '01',
      arm9RomOffset: 0x4000,
      arm9EntryAddr: 0x02000800,
      arm9RamAddr:   0x02000000,
      arm9Size:      0x12345,
      arm7RomOffset: 0x100000,
      arm7EntryAddr: 0x037F8000,
      arm7RamAddr:   0x037F8000,
      arm7Size:      0x6789,
    });
    const h = parseNdsHeader(rom);
    expect(h.title).toBe('POKEMON');
    expect(h.gameCode).toBe('CPUE');
    expect(h.makerCode).toBe('01');
    expect(h.arm9RomOffset).toBe(0x4000);
    expect(h.arm9EntryAddr).toBe(0x02000800);
    expect(h.arm9RamAddr).toBe(0x02000000);
    expect(h.arm9Size).toBe(0x12345);
    expect(h.arm7RomOffset).toBe(0x100000);
    expect(h.arm7EntryAddr).toBe(0x037F8000);
    expect(h.arm7RamAddr).toBe(0x037F8000);
    expect(h.arm7Size).toBe(0x6789);
  });

  it('extracts the 4-char ASCII game code', () => {
    const rom = buildHeader({ gameCode: 'AXVE' });
    const h = parseNdsHeader(rom);
    expect(h.gameCode).toBe('AXVE');
    expect(h.gameCode.length).toBe(4);
  });

  it('reads unitCode 0/1/2/3 verbatim and exposes a human name', () => {
    for (const unit of [0, 1, 2, 3]) {
      const rom = buildHeader({ unitCode: unit });
      const h = parseNdsHeader(rom);
      expect(h.unitCode).toBe(unit);
    }
    expect(unitCodeName(0)).toBe('NDS');
    expect(unitCodeName(2)).toBe('NDS + DSi');
    expect(unitCodeName(3)).toBe('DSi-only');
    expect(unitCodeName(5)).toContain('unknown');
  });

  it('reads bannerOffset as a 32-bit value', () => {
    const rom = buildHeader({ bannerOffset: 0x000A8000 });
    const h = parseNdsHeader(rom);
    expect(h.bannerOffset).toBe(0x000A8000);
  });

  it('reads FNT and FAT offsets / sizes independently', () => {
    const rom = buildHeader({
      fntOffset: 0x40000, fntSize: 0x1234,
      fatOffset: 0x50000, fatSize: 0x5678,
    });
    const h = parseNdsHeader(rom);
    expect(h.fntOffset).toBe(0x40000);
    expect(h.fntSize).toBe(0x1234);
    expect(h.fatOffset).toBe(0x50000);
    expect(h.fatSize).toBe(0x5678);
  });

  it('round-trips the header CRC value (parser does not verify it)', () => {
    const rom = buildHeader({ headerCrc: 0xABCD });
    const h = parseNdsHeader(rom);
    expect(h.headerCrc).toBe(0xABCD);
  });

  it('rejects a ROM smaller than the 512-byte header', () => {
    expect(() => parseNdsHeader(new Uint8Array(100))).toThrow(/smaller than 512/);
  });
});
