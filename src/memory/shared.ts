// Memory blocks that BOTH the ARM9 and ARM7 cores can touch (with
// optional routing). We instantiate these once at the emulator level
// and hand the same references to both buses, so a write from ARM9 is
// observable from ARM7 next cycle (and vice versa) — that's how the
// real hardware behaves for Main RAM and the shared WRAM block.

import {
  MAIN_RAM_SIZE,
  SHARED_WRAM_SIZE,
  ARM7_IWRAM_SIZE,
  PRAM_SIZE,
  OAM_SIZE,
  VRAM_TOTAL_SIZE,
} from './regions';

export class SharedMemory {
  // 4 MB Main RAM — both CPUs see the same bytes.
  mainRam = new Uint8Array(MAIN_RAM_SIZE);
  // 32 KB shared WRAM block — split between CPUs by WRAMCNT.
  sharedWram = new Uint8Array(SHARED_WRAM_SIZE);
  // 64 KB ARM7-only IWRAM.
  arm7Iwram = new Uint8Array(ARM7_IWRAM_SIZE);
  // 2 KB palette RAM (engine A 1 KB + engine B 1 KB).
  pram = new Uint8Array(PRAM_SIZE);
  // 2 KB OAM (engine A 1 KB + engine B 1 KB).
  oam = new Uint8Array(OAM_SIZE);
  // 656 KB VRAM (we'll partition by bank-routing later; for now it's a
  // flat block that LCDC reads can index).
  vram = new Uint8Array(VRAM_TOTAL_SIZE);

  // WRAMCNT controls how the 32 KB shared block is split. Values:
  //   0 → all 32 KB to ARM9, ARM7 sees its IWRAM mirror at 0x03000000
  //   1 → 2nd half (upper 16 KB) to ARM9, 1st half to ARM7
  //   2 → 1st half (lower 16 KB) to ARM9, 2nd half to ARM7
  //   3 → all 32 KB to ARM7, ARM9 sees zeros at 0x03000000
  //
  // After reset, real hardware has WRAMCNT=0. The ARM9 BIOS then sets
  // it to 3 (all-to-ARM7) before signaling ARM7 to take over. We run
  // both CPUs concurrently and have no BIOS handoff, so initializing
  // to 3 here matches what ARM9 would have done — and Pokemon
  // Platinum's ARM7 autoload writes 0x037F8000+ expecting shared
  // WRAM to be mapped there.
  wramcnt = 3;

  // Tiny BIOS regions, one per CPU. Reads from 0x00000000..0x00003FFF
  // (and 0xFFFF0000..0xFFFF3FFF on ARM9) hit these — we pre-load a
  // canonical IRQ-dispatch stub at offset 0x18 so any IRQ taken on the
  // exception vector actually finds something to execute.
  biosArm7 = new Uint8Array(16 * 1024);
  biosArm9 = new Uint8Array(16 * 1024);
}
