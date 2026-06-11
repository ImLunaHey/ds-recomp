// Tetris DS (game code ATRE) panic-loop bypass.
//
// Tetris reaches an explicit `B 0x02026F54` (branch-to-self) trap inside
// its SDK init after our PXI stubs let it past the original SNDi gate.
// The trap is the default-fallthrough branch of a small jump table that
// dispatches on a status word returned from a chain of helper functions:
//
//   0x02026F20: CMP R0, #6
//   0x02026F24: ADDLS PC, PC, R0, LSL #2   ; jump table
//     entry 0,1,3,4 → B 0x02026F64         ; success path
//     entry 2,6,7   → B 0x02026F48 → 0x02026F54  ; trap
//     entry 5       → B 0x02026F58         ; alt path
//   0x02026F48: LDR R1,[PC,#0x44]
//   0x02026F4C: MOV R0,R5
//   0x02026F50: BL  0x02026F9C             ; SDK printf (error msg)
//   0x02026F54: B   0x02026F54             ; <-- trap
//
// What lands the status word at 6 in our build:
//
// One of the helpers under the dispatch is 0x0200F20C, an "is the WMi
// (wireless manager) ARM7 worker idle and accepting a new command?"
// probe. It reads a flag word at 0x02078B80 — set by ARM7's WMi
// IRQ handler when it picks up a command, cleared when the handler
// completes. Without a real ARM7-side WMi subsystem the flag toggles
// in a way the ARM9 caller doesn't expect, the four-try retry loop
// in 0x0202FC34 gives up, the outer scheduler returns 6, the switch
// drops into the trap, and the game is stuck for ~1200 frames before
// it gives up.
//
// The trap target (0x02026F58 / 0x02026F64) just calls 0x02046A50 (a
// "tear down + reboot to title" type routine) and returns from the
// outer scheduler. Rewriting the trap word from `B .` to `B 0x02026F64`
// makes the failure path behave like cases 0/1/3/4 (success-into-
// teardown), and Tetris reaches the title screen on the next iteration
// of the scheduler.
//
// Gated by the four-character game code at ROM offset 0x0C. Every other
// retail ROM happens to have a different word at 0x02026F54 (or no code
// there at all), so the patch is a no-op for them — but we still gate
// to make grep audits trivial: "where do we touch Tetris memory?".

import { MAIN_RAM_MASK } from '../memory/regions';

// Tetris DS USA game code (NTR-ATRE-USA). PAL/JPN have different codes
// (ATRP / ATRJ) and slightly different binaries — if they show up later
// they'll need their own offsets verified.
const TETRIS_DS_GAME_CODE = 'ATRE';

// Address of the branch-to-self that the SDK init's dispatch lands on
// when its WMi probe gives up. Inside the static ARM9 binary copied to
// 0x02000000 (binary size = 0x770B8 in the USA ROM), so a one-shot
// patch at load time is enough — no overlay reload can re-introduce it.
const PANIC_ADDR = 0x02026F54;

// Sentinel: original word at PANIC_ADDR for the USA build. If a future
// ROM build (e.g. a localized release we grow support for) doesn't
// match, we skip the patch rather than risk overwriting unrelated code.
//   ARM B-self: cond=AL, opcode=A, offset=-2 (per ARM PC+8 semantics)
//   → 0xEAFFFFFE
const EXPECTED_PANIC_WORD = 0xEAFFFFFE;

// Replacement word: `B 0x02026F64` (forward by 2 words from the
// instruction at 0x02026F54). Encoding: cond=AL (0xE), opcode=A, offset
// field = 2 (= (target - PC - 8) / 4 with PC = 0x02026F54).
//   → 0xEA000002
const PATCH_WORD = 0xEA000002;

/**
 * Patch the Tetris DS panic loop in main RAM if the loaded cart is
 * Tetris DS (USA, game code ATRE). No-op for any other ROM.
 *
 * Must be called AFTER the ARM9 binary has been copied into main RAM
 * by `loadNdsRom`. Idempotent — patching twice is harmless since the
 * second call sees PATCH_WORD instead of EXPECTED_PANIC_WORD and skips.
 */
export function applyTetrisPanicPatch(rom: Uint8Array, mainRam: Uint8Array): boolean {
  // ROM too small to even hold the header — bail.
  if (rom.length < 0x10) return false;
  const gameCode = new TextDecoder().decode(rom.subarray(0x0C, 0x10));
  if (gameCode !== TETRIS_DS_GAME_CODE) return false;

  const off = PANIC_ADDR & MAIN_RAM_MASK;
  if (off + 4 > mainRam.length) return false;

  // Verify the word in main RAM matches what we expect before touching
  // it. If a future ROM version puts something else there, we don't
  // want to silently corrupt the binary.
  const current =
    (mainRam[off]            |
     (mainRam[off + 1] <<  8) |
     (mainRam[off + 2] << 16) |
     (mainRam[off + 3] << 24)) >>> 0;
  if (current !== EXPECTED_PANIC_WORD) return false;

  mainRam[off]     =  PATCH_WORD        & 0xFF;
  mainRam[off + 1] = (PATCH_WORD >>>  8) & 0xFF;
  mainRam[off + 2] = (PATCH_WORD >>> 16) & 0xFF;
  mainRam[off + 3] = (PATCH_WORD >>> 24) & 0xFF;
  return true;
}
