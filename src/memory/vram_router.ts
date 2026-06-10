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

  // ─── Extended palette resolution ───────────────────────────────────
  //
  // The DS exposes BG and OBJ "extended" palettes via four virtual
  // alias regions on the ARM9 bus. The renderer doesn't read these
  // through resolveArm9() — they aren't true VRAM-window aliases, the
  // PPU consults them directly through the helpers below — so the
  // routing here is just "which bank is mapped to this ext-palette
  // role under VRAMCNT, and at what offset within the bank?". Per
  // GBATEK §"VRAM Allocation":
  //
  //   Engine A BG ext palette (4 slots × 8 KB = 32 KB at 0x06880000):
  //     Bank E MST=4: provides all 4 slots.
  //     Bank F MST=4: provides one 8 KB slot, picked by OFFSET:
  //       OFFSET bit 0 = 0 → slots 0/1, = 1 → slots 2/3
  //       OFFSET bit 1 = which slot in the chosen pair
  //     Bank G MST=4: same scheme as F.
  //
  //   Engine A OBJ ext palette (single 8 KB region at 0x06890000):
  //     Bank F MST=5: provides 8 KB (low half of the bank).
  //     Bank G MST=5: same as F.
  //
  //   Engine B BG ext palette (4 slots × 8 KB = 32 KB at 0x06898000):
  //     Bank H MST=2: provides all 4 slots.
  //
  //   Engine B OBJ ext palette (single 8 KB region at 0x068A0000):
  //     Bank I MST=3: provides 8 KB.

  // Engine A BG ext palette slot lookup. slot ∈ [0,4), off ∈ [0,0x2000).
  // Returns the flat shared.vram[] byte index, or -1 if no bank is
  // currently mapped to that role/slot.
  resolveBgExtPalA(slot: number, off: number): number {
    // Bank E MST=4 covers all 4 slots (32 KB).
    if ((this.vramcnt[4] & 0x87) === 0x84) {
      return BANK_INFO[4].start + slot * 0x2000 + off;
    }
    // Banks F and G with MST=4 each contribute a single 8 KB slot.
    // OFFSET bit 0 picks the pair (0 = slots 0/1, 1 = slots 2/3),
    // OFFSET bit 1 picks within the pair.
    for (const i of [5, 6]) {
      if ((this.vramcnt[i] & 0x87) !== 0x84) continue;
      const ofsField = (this.vramcnt[i] >> 3) & 0x3;
      const mappedSlot = (ofsField & 1) * 2 + ((ofsField >> 1) & 1);
      if (mappedSlot === slot) {
        return BANK_INFO[i].start + off;
      }
    }
    return -1;
  }

  // Engine B BG ext palette. Bank H MST=2 supplies all 4 slots (32 KB).
  resolveBgExtPalB(slot: number, off: number): number {
    if ((this.vramcnt[7] & 0x87) === 0x82) {
      return BANK_INFO[7].start + slot * 0x2000 + off;
    }
    return -1;
  }

  // Engine A OBJ ext palette. F (MST=5) wins over G if both are mapped.
  resolveObjExtPalA(off: number): number {
    if ((this.vramcnt[5] & 0x87) === 0x85) return BANK_INFO[5].start + off;
    if ((this.vramcnt[6] & 0x87) === 0x85) return BANK_INFO[6].start + off;
    return -1;
  }

  // Engine B OBJ ext palette. Bank I MST=3 (8 KB).
  resolveObjExtPalB(off: number): number {
    if ((this.vramcnt[8] & 0x87) === 0x83) {
      return BANK_INFO[8].start + off;
    }
    return -1;
  }
}

// Module-level reference to the active VramRouter. The PPU scanline
// renderers (text_bg.ts, sprites.ts) need to look up ext palette banks,
// but their function signatures are locked by engine_a.ts. Emulator
// installs the active router here at startup so the renderers can find
// it without a parameter-passing change.
let _activeRouter: VramRouter | null = null;
export function setActiveVramRouter(r: VramRouter): void { _activeRouter = r; }
export function getActiveVramRouter(): VramRouter | null { return _activeRouter; }
