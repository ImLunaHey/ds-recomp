// NDS cartridge header parser. The first 0x200 bytes of an .nds file
// describe where the ARM9/ARM7 binaries live in the ROM, where they
// load into RAM, their entry points, plus FAT/FNT/banner offsets and
// the game title + 4-char game code. GBATEK §"DS Cartridge Header" is
// the canonical reference.

export interface NdsHeader {
  title: string;        // 12-char ASCII (trailing NULs stripped)
  gameCode: string;     // 4-char ASCII (e.g. "CPUE" = Pokemon Platinum USA)
  makerCode: string;    // 2-char ASCII (e.g. "01" = Nintendo)
  unitCode: number;     // 0 = NDS, 2 = NDS+DSi, 3 = DSi-only
  romVersion: number;
  capacityShift: number;     // ROM size = 128 KB << capacityShift
  arm9RomOffset: number;
  arm9EntryAddr: number;
  arm9RamAddr: number;
  arm9Size: number;
  arm7RomOffset: number;
  arm7EntryAddr: number;
  arm7RamAddr: number;
  arm7Size: number;
  fntOffset: number;
  fntSize: number;
  fatOffset: number;
  fatSize: number;
  arm9OverlayOffset: number;
  arm9OverlaySize: number;
  arm7OverlayOffset: number;
  arm7OverlaySize: number;
  bannerOffset: number;
  headerCrc: number;
  totalUsedRomSize: number;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset + length;
  // Trim trailing NULs / spaces.
  while (end > offset && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end--;
  let out = '';
  for (let i = offset; i < end; i++) {
    const b = bytes[i];
    out += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '?';
  }
  return out;
}

export function parseNdsHeader(rom: Uint8Array): NdsHeader {
  if (rom.length < 0x200) throw new Error('ROM smaller than 512-byte header');
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  return {
    title:           readAscii(rom, 0x000, 12),
    gameCode:        readAscii(rom, 0x00C, 4),
    makerCode:       readAscii(rom, 0x010, 2),
    unitCode:        rom[0x012],
    capacityShift:   rom[0x014],
    romVersion:      rom[0x01E],
    arm9RomOffset:   dv.getUint32(0x020, true),
    arm9EntryAddr:   dv.getUint32(0x024, true),
    arm9RamAddr:     dv.getUint32(0x028, true),
    arm9Size:        dv.getUint32(0x02C, true),
    arm7RomOffset:   dv.getUint32(0x030, true),
    arm7EntryAddr:   dv.getUint32(0x034, true),
    arm7RamAddr:     dv.getUint32(0x038, true),
    arm7Size:        dv.getUint32(0x03C, true),
    fntOffset:       dv.getUint32(0x040, true),
    fntSize:         dv.getUint32(0x044, true),
    fatOffset:       dv.getUint32(0x048, true),
    fatSize:         dv.getUint32(0x04C, true),
    arm9OverlayOffset: dv.getUint32(0x050, true),
    arm9OverlaySize:   dv.getUint32(0x054, true),
    arm7OverlayOffset: dv.getUint32(0x058, true),
    arm7OverlaySize:   dv.getUint32(0x05C, true),
    bannerOffset:    dv.getUint32(0x068, true),
    headerCrc:       dv.getUint16(0x15E, true),
    totalUsedRomSize: dv.getUint32(0x080, true),
  };
}

export function unitCodeName(unit: number): string {
  switch (unit) {
    case 0: return 'NDS';
    case 2: return 'NDS + DSi';
    case 3: return 'DSi-only';
    default: return `unknown (${unit})`;
  }
}
