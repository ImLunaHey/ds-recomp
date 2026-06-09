// VRAM bank router. Each of the 9 NDS VRAM banks (A..I) has a
// VRAMCNT_x register controlling whether it's enabled, what kind of
// mapping it has (MST), and which "slot" of that mapping it occupies
// (OFFSET). This class translates an ARM9 or ARM7 VRAM-window address
// into a flat offset into shared.vram[], or -1 if no bank covers it.
//
// shared.vram[] layout (matches VRAM_TOTAL_SIZE = 656 KB):
//   bank A: vram[0x00000..0x1FFFF]   128 KB
//   bank B: vram[0x20000..0x3FFFF]   128 KB
//   bank C: vram[0x40000..0x5FFFF]   128 KB
//   bank D: vram[0x60000..0x7FFFF]   128 KB
//   bank E: vram[0x80000..0x8FFFF]    64 KB
//   bank F: vram[0x90000..0x93FFF]    16 KB
//   bank G: vram[0x94000..0x97FFF]    16 KB
//   bank H: vram[0x98000..0x9FFFF]    32 KB
//   bank I: vram[0xA0000..0xA3FFF]    16 KB

const BANK_INFO = [
  { start: 0x00000, size: 0x20000 },   // A
  { start: 0x20000, size: 0x20000 },   // B
  { start: 0x40000, size: 0x20000 },   // C
  { start: 0x60000, size: 0x20000 },   // D
  { start: 0x80000, size: 0x10000 },   // E
  { start: 0x90000, size: 0x04000 },   // F
  { start: 0x94000, size: 0x04000 },   // G
  { start: 0x98000, size: 0x08000 },   // H
  { start: 0xA0000, size: 0x04000 },   // I
] as const;

// Fixed LCDC alias addresses for each bank.
const LCDC_BASE = [
  0x06800000, 0x06820000, 0x06840000, 0x06860000,   // A, B, C, D
  0x06880000, 0x06890000, 0x06894000, 0x06898000,   // E, F, G, H
  0x068A0000,                                         // I
] as const;

export class VramRouter {
  // VRAMCNT_A..I, indexed 0..8. Bit 7 = enable, bits 0:2 = MST,
  // bits 3:4 = OFFSET. Stored elsewhere (in Ppu) but read here for
  // every VRAM access; that's fine for correctness, future optimization
  // can cache a precomputed page table.
  vramcnt: Uint8Array;

  constructor(vramcnt: Uint8Array) {
    this.vramcnt = vramcnt;
  }

  // ARM9 view of VRAM. Walks the 9 banks and returns the first that
  // covers `addr`, or -1 if no bank is mapped there.
  resolveArm9(addr: number): number {
    addr = addr >>> 0;
    // LCDC alias range: fixed addresses regardless of MST.
    if (addr >= 0x06800000 && addr < 0x06800000 + 0xA4000) {
      // Walk banks in LCDC mode and see which contains the addr.
      for (let i = 0; i < 9; i++) {
        const cnt = this.vramcnt[i];
        if ((cnt & 0x80) === 0) continue;
        const mst = cnt & 0x7;
        if (mst !== 0) continue;          // only LCDC mode appears here
        const base = LCDC_BASE[i];
        const info = BANK_INFO[i];
        if (addr >= base && addr < base + info.size) {
          return info.start + (addr - base);
        }
      }
      return -1;
    }
    // BG window 0x06000000..0x0607FFFF (main engine A BG VRAM).
    if (addr >= 0x06000000 && addr < 0x06080000) {
      for (let i = 0; i < 9; i++) {
        const cnt = this.vramcnt[i];
        if ((cnt & 0x80) === 0) continue;
        const mst = cnt & 0x7;
        // Engine A BG mode: A/B/C/D mst=1; E mst=1; F/G mst=1.
        if (i <= 3 && mst === 1) {
          const ofs = (cnt >> 3) & 0x3;
          const base = 0x06000000 + ofs * 0x20000;
          const info = BANK_INFO[i];
          if (addr >= base && addr < base + info.size) return info.start + (addr - base);
        }
        if (i === 4 && mst === 1) {
          // Bank E to engine A BG mode is at 0x06000000 (64KB).
          if (addr >= 0x06000000 && addr < 0x06010000) return BANK_INFO[4].start + (addr - 0x06000000);
        }
        if ((i === 5 || i === 6) && mst === 1) {
          // F/G to engine A BG. OFS picks slot.
          const ofs = (cnt >> 3) & 0x3;
          const slot = [0x0000, 0x4000, 0x10000, 0x14000][ofs];
          const base = 0x06000000 + slot;
          if (addr >= base && addr < base + 0x4000) return BANK_INFO[i].start + (addr - base);
        }
      }
      return -1;
    }
    // OBJ window 0x06400000..0x0643FFFF (main engine A OBJ VRAM).
    if (addr >= 0x06400000 && addr < 0x06440000) {
      for (let i = 0; i < 9; i++) {
        const cnt = this.vramcnt[i];
        if ((cnt & 0x80) === 0) continue;
        const mst = cnt & 0x7;
        if (i <= 1 && mst === 2) {
          const ofs = (cnt >> 3) & 0x1;
          const base = 0x06400000 + ofs * 0x20000;
          const info = BANK_INFO[i];
          if (addr >= base && addr < base + info.size) return info.start + (addr - base);
        }
        if (i === 4 && mst === 2) {
          if (addr >= 0x06400000 && addr < 0x06410000) return BANK_INFO[4].start + (addr - 0x06400000);
        }
        if ((i === 5 || i === 6) && mst === 2) {
          const ofs = (cnt >> 3) & 0x3;
          const slot = [0x0000, 0x4000, 0x10000, 0x14000][ofs];
          const base = 0x06400000 + slot;
          if (addr >= base && addr < base + 0x4000) return BANK_INFO[i].start + (addr - base);
        }
      }
      return -1;
    }
    // Sub-BG window 0x06200000..0x0621FFFF (engine B BG).
    if (addr >= 0x06200000 && addr < 0x06220000) {
      // Bank C MST=4 OFS=0 (engine B BG) - 128 KB.
      if ((this.vramcnt[2] & 0x87) === 0x84 && addr < 0x06220000) {
        return BANK_INFO[2].start + (addr - 0x06200000);
      }
      // Bank H MST=1 (engine B BG) - 32 KB at start.
      if ((this.vramcnt[7] & 0x87) === 0x81 && addr < 0x06208000) {
        return BANK_INFO[7].start + (addr - 0x06200000);
      }
      // Bank I MST=1 (engine B BG slot 2) at 0x06208000.
      if ((this.vramcnt[8] & 0x87) === 0x81 && addr >= 0x06208000 && addr < 0x0620C000) {
        return BANK_INFO[8].start + (addr - 0x06208000);
      }
      return -1;
    }
    return -1;
  }

  // ARM7 view of VRAM. Only banks C and D, when MST=2, are reachable
  // from ARM7 (at 0x06000000-0x0603FFFF depending on OFS).
  resolveArm7(addr: number): number {
    addr = addr >>> 0;
    if (addr < 0x06000000 || addr >= 0x06040000) return -1;
    for (const i of [2, 3]) {
      const cnt = this.vramcnt[i];
      if ((cnt & 0x87) !== 0x82) continue;     // enabled + MST=2
      const ofs = (cnt >> 3) & 0x1;
      const base = 0x06000000 + ofs * 0x20000;
      if (addr >= base && addr < base + 0x20000) {
        return BANK_INFO[i].start + (addr - base);
      }
    }
    return -1;
  }

  // VRAMSTAT (ARM7 view of 0x04000240): bit 0 = bank C allocated to
  // ARM7, bit 1 = bank D allocated to ARM7.
  readVramStat(): number {
    let v = 0;
    if ((this.vramcnt[2] & 0x87) === 0x82) v |= 0x01;
    if ((this.vramcnt[3] & 0x87) === 0x82) v |= 0x02;
    return v;
  }
}
