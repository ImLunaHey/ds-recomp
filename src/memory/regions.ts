// Nintendo DS memory map constants. Both CPUs share Main RAM (4 MB) but
// otherwise see different regions — ARM9 has CP15 TCMs and the bigger
// VRAM window, ARM7 has its own 64 KB IWRAM and the WRAM block. GBATEK
// §"DS Memory Map" is the canonical reference.

// Main RAM (shared 4 MB block, mirrored in higher 24 MB).
export const MAIN_RAM_BASE = 0x02000000;
export const MAIN_RAM_SIZE = 4 * 1024 * 1024;
export const MAIN_RAM_MASK = MAIN_RAM_SIZE - 1;

// Shared WRAM (32 KB block — can be split 0/16/32 KB between CPUs by
// WRAMCNT on ARM9). Visible to ARM9 at 0x03000000 and to ARM7 at
// 0x03000000 (when allocated to it) plus its own 64 KB IWRAM at
// 0x03800000.
export const SHARED_WRAM_BASE = 0x03000000;
export const SHARED_WRAM_SIZE = 32 * 1024;
export const SHARED_WRAM_MASK = SHARED_WRAM_SIZE - 1;

// ARM7 IWRAM — 64 KB, always at 0x03800000 from ARM7's view.
export const ARM7_IWRAM_BASE = 0x03800000;
export const ARM7_IWRAM_SIZE = 64 * 1024;
export const ARM7_IWRAM_MASK = ARM7_IWRAM_SIZE - 1;

// IO ports.
export const IO_BASE = 0x04000000;

// Palette RAM (ARM9 only) — 1 KB engine A + 1 KB engine B.
export const PRAM_BASE = 0x05000000;
export const PRAM_SIZE = 2 * 1024;

// VRAM (ARM9 only, lots of bank-routing complexity). Banks A..G total
// 656 KB; each bank gets mapped to an LCDC / BG / OBJ / texture / ext.
// palette slot via VRAMCNT_A..G.
export const VRAM_BASE = 0x06000000;
export const VRAM_TOTAL_SIZE = 656 * 1024;

// OAM (ARM9 only) — 1 KB engine A + 1 KB engine B.
export const OAM_BASE = 0x07000000;
export const OAM_SIZE = 2 * 1024;

// Cartridge ROM/RAM windows.
export const GBA_ROM_BASE = 0x08000000;
export const GBA_RAM_BASE = 0x0A000000;

// ARM9 TCMs are configured via CP15 — they live at addresses chosen by
// the running code. We expose their sizes for the bus to allocate.
export const ITCM_SIZE = 32 * 1024;
export const DTCM_SIZE = 16 * 1024;
