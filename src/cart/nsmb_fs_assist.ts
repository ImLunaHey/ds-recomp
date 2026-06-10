// NSMB NitroFS read assist.
//
// PPU's applyNsmbFsThunk() already installs a "MOV R0,#6 ; BX LR" ARM
// thunk at 0x023FF800 and points every FS-Archive handle's vtable slot
// (+0x50) at it, so the SDK's dispatcher at 0x02069704 falls through its
// "completed synchronously" branch instead of spinning forever. That gets
// the FS state machine unstuck, but the dispatcher's callback is supposed
// to ALSO move the requested bytes from cart ROM into the destination
// buffer in main RAM. The thunk by itself does no such copy, so NSMB
// happily marks each read "done" while every dst buffer stays zero —
// which is why the title screen renders to solid white (palette uploaded
// from `.data`, but no VRAM tile/map data ever materialises).
//
// What the dispatcher passes on every BLX into the thunk (captured by
// running 200 frames of NSMB and snapshotting register state when PC
// first lands at 0x023FF800):
//
//   R0 = FS handle pointer (e.g. 0x02096114, the "rom\0" primary handle)
//   R1 = destination buffer in main RAM (e.g. 0x027E3764)
//   R2 = source byte offset within cart ROM (e.g. 0x00226EA0 = FNT base)
//   R3 = byte count to copy (e.g. 8 = the first FNT directory record)
//
// And the dispatcher expects on return:
//
//   R0 = 6  → "operation completed synchronously"
//   handle state word at [R0_in, #0x1C] has bit 0x200 cleared
//   PC = LR
//
// performNsmbFsRead does all of that in JS in one shot, then nudges PC
// back to LR so the inline ARM thunk body never actually executes — the
// bytes still live in main RAM as a fallback (and a few tests in
// nsmb_fs_thunk.test.ts execute them directly via Cpu.step), but in
// normal emulation we shortcut around them and copy the bytes.
//
// We deliberately keep this assist physically separate from the PPU's
// VBlank hook. The PPU thunk's job is "let the SDK think the read
// finished"; this module's job is "actually make the read happen".
// Wiring is one line in Emulator.runFrame() — after each cpu9.step(),
// if cpu9 just entered the thunk address, run this once.

import type { Cpu } from '../cpu/cpu';
import { MAIN_RAM_MASK, MAIN_RAM_SIZE } from '../memory/regions';

// Same address the PPU installs the thunk at. Kept as a free-standing
// constant rather than imported so this module stays decoupled from the
// PPU's private statics — both sides agree on the value via test.
export const NSMB_FS_THUNK_ADDR = 0x023FF800;

// Sanity bounds on the size we'll accept from the dispatcher. Real NSMB
// FS reads observed during boot range from 8 bytes (FNT root record) to
// a few hundred KB (compressed graphics blob). Anything past a few MB
// is almost certainly garbage and we'd rather no-op the read than write
// gibberish into main RAM.
const MAX_FS_READ_BYTES = 8 * 1024 * 1024;

// Bit pattern the dispatcher stamps into handle.state (+0x1C) before
// BLX-ing the callback. The "synchronously completed" branch
// (0x02069760) never clears this bit itself — only the R0=0/R0=1
// branches do. Our thunk clears it on the way out so future FS calls
// see an idle handle.
const FS_STATE_IN_PROGRESS_BIT = 0x200;

// Return code the dispatcher recognises as "completed synchronously"
// (CMP R0,#6 ; BEQ <completion>).
const FS_RETURN_SYNC_COMPLETE = 6;

export interface NsmbFsAssistDeps {
  // Cart ROM bytes (Cart.rom). We index it directly — the ROM is
  // already fully parsed in main memory by loadRom(), so no cart-DMA
  // round-trip is needed for the assist's copy.
  rom: Uint8Array;
  // Shared main RAM buffer (SharedMemory.mainRam). Destination writes
  // go straight into here; the bus mirrors at 0x027xxxxx and 0x023xxxxx
  // pick the bytes up next read.
  mainRam: Uint8Array;
}

// Hook entry — call once per cpu9.step() with the post-step PC. Returns
// true if the call handled an FS read (caller may use this for stats /
// throttling). Idempotent and very fast on the common no-match path.
export function tryHandleNsmbFsThunk(cpu: Cpu, deps: NsmbFsAssistDeps): boolean {
  const pc = cpu.state.r[15] & ~3;
  if (pc !== NSMB_FS_THUNK_ADDR) return false;
  return performNsmbFsRead(cpu, deps);
}

// Inner — public so tests can drive it with a known register state
// without having to set up the whole PC-equals-thunk-addr precondition.
export function performNsmbFsRead(cpu: Cpu, deps: NsmbFsAssistDeps): boolean {
  const s = cpu.state;
  const handlePtr = s.r[0] >>> 0;
  const dstAddr   = s.r[1] >>> 0;
  const srcOff    = s.r[2] >>> 0;
  const length    = s.r[3] >>> 0;
  const lr        = s.r[14] >>> 0;

  // Validate dst lies somewhere in the main-RAM mirror window. NSMB's
  // SDK heap actually allocates out of the 0x027xxxxx alias range (one
  // of the 4 MB-mirrored slices in the 16 MB main-RAM window, GBATEK
  // §"DS Memory Map") rather than the canonical 0x02000000 base, so we
  // accept any pointer whose region nibble is 0x02 and resolve the
  // physical offset via MAIN_RAM_MASK (= MAIN_RAM_SIZE - 1). The mask
  // collapses every mirror back onto the same 4 MB byte store.
  const dstRegion = (dstAddr >>> 24) & 0xFF;
  if (dstRegion !== 0x02) return false;
  if (length === 0 || length > MAX_FS_READ_BYTES) return false;
  // Reject reads that would wrap past the 4 MB boundary inside the
  // mirrored slice — those would silently smear into the start of main
  // RAM, almost always a sign of a struct misinterpretation.
  if (((dstAddr & MAIN_RAM_MASK) + length) > MAIN_RAM_SIZE) return false;

  // Validate src + len fits in ROM. Out-of-range reads zero-pad to
  // match GBATEK's "reading past cart end returns 0xFFFFFFFF" pattern,
  // but for an SDK FS read those should never happen — if they do it
  // signals a struct misinterpretation, so we no-op (and the thunk's
  // inline ARM bytes will fire instead and at least clear the busy bit).
  if (srcOff >= deps.rom.length) return false;
  const copyLen = Math.min(length, deps.rom.length - srcOff);

  // Copy ROM bytes into the destination buffer. Uint8Array.set is the
  // fastest path JS gives us; both arrays are flat byte stores so this
  // bottoms out in a single C memcpy inside V8.
  const dstOff = dstAddr & MAIN_RAM_MASK;
  deps.mainRam.set(deps.rom.subarray(srcOff, srcOff + copyLen), dstOff);
  // Zero-pad any tail past ROM end — keeps the destination buffer
  // deterministic when the dispatcher (very rarely) asks for more
  // bytes than ROM has at the requested offset.
  if (copyLen < length) {
    deps.mainRam.fill(0, dstOff + copyLen, dstOff + length);
  }

  // Clear the "operation in progress" bit on the handle's state word.
  // We do this even though the inline ARM thunk would also do it on its
  // way out — if a future change short-circuits the inline bytes (or a
  // test runs this function directly), we don't want the handle left
  // marked busy. Read-modify-write through the same main-RAM mirror as
  // the bus would, so both 0x023FF800-style canonical and 0x027FFxxx
  // mirror reads pick up the change.
  const stateOff = (handlePtr + 0x1C) & MAIN_RAM_MASK;
  if (stateOff + 4 <= deps.mainRam.length) {
    let state =
      (deps.mainRam[stateOff]            |
       (deps.mainRam[stateOff + 1] <<  8) |
       (deps.mainRam[stateOff + 2] << 16) |
       (deps.mainRam[stateOff + 3] << 24)) >>> 0;
    state &= ~FS_STATE_IN_PROGRESS_BIT;
    deps.mainRam[stateOff]     =  state        & 0xFF;
    deps.mainRam[stateOff + 1] = (state >>  8) & 0xFF;
    deps.mainRam[stateOff + 2] = (state >> 16) & 0xFF;
    deps.mainRam[stateOff + 3] = (state >> 24) & 0xFF;
  }

  // Return code + BX LR. The dispatcher's caller was in ARM mode
  // (dispatcher itself is ARM, BLX R4 with R4 = thunk addr leaves
  // CPSR.T = 0) and LR was the post-BLX return address — so the
  // restore is a straight PC = LR with no Thumb-mode toggle. We keep
  // a defensive bit-0 check anyway in case some future caller jumps
  // in from Thumb code: the BX semantics mandate following LR's bit 0.
  s.r[0] = FS_RETURN_SYNC_COMPLETE;
  if (lr & 1) {
    // Thumb return target.
    s.cpsr |= 0x20; // FLAG_T — keeping the literal here so this module
                    // doesn't need to import from cpu/state (which is
                    // out of scope for this change). FLAG_T = 0x20 is
                    // a hardware invariant and won't move.
    s.r[15] = (lr & ~1) >>> 0;
  } else {
    s.cpsr &= ~0x20;
    s.r[15] = (lr & ~3) >>> 0;
  }
  // Treat as a control-flow change so the CPU's normal "advance by
  // insnSize" path doesn't run after our injection. The CPU exposes a
  // `branched` flag for exactly this purpose.
  cpu.branched = true;
  return true;
}
