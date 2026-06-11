// NitroSDK OS-thread HLE assist. Pokes the game out of a deadlocked
// wait-for-thread-wakeup pattern that the SDK enters when a thread we
// never actually run was supposed to signal completion.
//
// Background. NitroSDK ships a cooperative thread package. A thread
// blocks via OS_SleepThread(condition) — the dispatcher walks a static
// OS_Thread linked-list anchored at OSi_ThreadInfo and parks the caller
// in the WAITING state with `thread.waitingOn = condition`. Another
// thread later calls OS_WakeupThread(condition) which scans the list and
// flips every matching thread back to RUNNABLE. If nothing is RUNNABLE,
// the kernel parks the ARM9 with a CP15 "Wait For Interrupt" (modeled
// in src/cpu/cp15.ts as a Cp15 write CRn=7 CRm=0 opc2=4 → halt).
//
// In our world, the second thread never gets to call OS_WakeupThread
// because we don't have a NitroSDK binary to call it from. NSMB's main
// task does an OS_SleepThread on the "init done" event; the init thread
// is the one we never executed past. Result: the ARM9 lands in WFI
// indefinitely, no IRQ source can wake it, and the game just sits in a
// blank-screen halt.
//
// Heuristic. Once per frame, we check whether the ARM9 has been halted
// in the WFI deadlock for an extended period (DEADLOCK_FRAMES) AND no
// IRQ source could plausibly wake it. If so, we walk a candidate area
// of main RAM looking for OS_Thread-shaped records, pick the first one
// in WAITING state, force-write the value its wait-condition word is
// expecting (its OWN address — that's the SDK's convention; see
// findWaitingThread), then raise IRQ_IPC_SYNC on ARM9. The IRQ lifts
// the halt; the user IRQ handler chain runs; the SDK's scheduler
// re-checks its run queue; the waiting thread wakes and execution
// advances past the deadlock.
//
// Conservative kicks. We require 60 CONSECUTIVE frames of WFI halt with
// no other wake source AND no recent IPC traffic before synthesizing
// anything. A working game (Tony Hawk PG, SM64DS) never sits in that
// state long because its IPC traffic and VBlank IRQs keep waking it,
// so the assist stays silent. Once we DO synthesize a wake, we check
// the PC every frame for 60 frames: if it moves to a fundamentally
// different region (delta > 0x1000), the wake worked and we sit out
// until the next deadlock; if it spins right back into WFI, we
// escalate to the next WAITING thread.
//
// Tuning knobs to revisit if this trips on a working game or fails on
// a new deadlock pattern:
//   DEADLOCK_FRAMES — frames of WFI before we'll act. 60 = 1 second.
//   PROGRESS_WINDOW — frames after wake we watch for forward progress.
//   PC_DELTA_GOOD   — PC delta we accept as "made progress".
//   THREAD_SCAN_REGION_LO/HI — main RAM byte range we scan for OS_Thread
//     records. NitroSDK heap typically sits in the upper half of the
//     4 MB main RAM, but games on different SDK versions place it
//     differently.

import type { Emulator } from '../emulator';
import { IRQ_IPC_SYNC } from '../io/irq';
import { MAIN_RAM_BASE, MAIN_RAM_MASK } from '../memory/regions';

// NitroSDK OS_Thread state codes (per the public NitroSDK headers — these
// constants are stable across SDK revisions because the kernel scheduler
// matches against them directly).
export const OS_THREAD_STATE_RUNNABLE = 0x0001;
export const OS_THREAD_STATE_WAITING  = 0x0002;
export const OS_THREAD_STATE_SLEEPING = 0x0004;
export const OS_THREAD_STATE_DEAD     = 0x0008;

// Heuristic thresholds. Tuned to fire only on a real, persistent
// deadlock — see the file header for justification.
const DEADLOCK_FRAMES = 60;       // 1 second of WFI halt before we act.
const PROGRESS_WINDOW = 60;       // frames after wake we expect progress.
const PC_DELTA_GOOD   = 0x1000;   // PC must jump at least this far.

// SDK system tick counter address. NitroSDK's VBlank handler bumps a
// u32 here every VBlank. The triage in commit a3199d0 traced LEGO
// Battles: Ninjago and Plants vs. Zombies to a busy-spin on this exact
// word (LEGO doesn't have an enabled VBlank IRQ; PvZ runs with global
// IME = false so its own handler can't fire). We bump it ourselves.
const SDK_TICK_COUNTER_ADDR = 0x02FFFF8C;

// PXI-drain heuristics. Drain only when the queue is at-or-above this
// many entries AND the streak has lasted this many frames — that's
// enough hysteresis to leave games with real ARM7 reply traffic alone.
const PXI_DRAIN_THRESHOLD = 12;   // 75% of the 16-entry FIFO.
const PXI_DRAIN_FRAMES    = 120;  // 2 seconds of "queue ≥ 12 + no ARM7 acks".

// Region of main RAM we scan for OS_Thread structs. NitroSDK's static
// allocator places the thread table inside the SDK reserved area near
// the top of main RAM (just below the 0x027FF800 BIOS-populated
// region), but games on different SDK versions place it differently
// — keep this wide enough to catch all of them.
const THREAD_SCAN_REGION_LO = 0x02000000;
const THREAD_SCAN_REGION_HI = 0x02400000;

// OS_Thread struct layout (NitroSDK os/thread.h, abbreviated; offsets
// are stable across SDK 5.x). Many fields aren't relevant to the
// assist — we only read the ones we need.
//
//   +0x00  context (ARM register save area, 18 words)
//   +0x48  next pointer (linked-list)
//   +0x4C  state (one of OS_THREAD_STATE_*)
//   +0x4E  flags
//   +0x50  priority
//   +0x54  prev pointer
//   +0x58  joinThread
//   +0x5C  mutexList
//   +0x60  waitingOn (the condition pointer / value the thread parked on)
//   +0x64  waitingThreadQueue
//   ...
const THREAD_STATE_OFF    = 0x4C;
const THREAD_WAITING_OFF  = 0x60;
const THREAD_STRUCT_MIN_SIZE = 0x70;

// Plausibility check for a candidate OS_Thread record. We require the
// state word to be one of the known state codes AND the struct to lie
// entirely within main RAM. False positives here are still bounded —
// we only EVER write the wait-condition word, never anything else.
function looksLikeThread(mem: Uint8Array, off: number): boolean {
  if (off < 0 || off + THREAD_STRUCT_MIN_SIZE > mem.length) return false;
  const state = read16(mem, off + THREAD_STATE_OFF);
  if (state === OS_THREAD_STATE_RUNNABLE) return true;
  if (state === OS_THREAD_STATE_WAITING)  return true;
  if (state === OS_THREAD_STATE_SLEEPING) return true;
  return false;
}

function read16(mem: Uint8Array, off: number): number {
  return (mem[off] | (mem[off + 1] << 8)) >>> 0;
}
function write32(mem: Uint8Array, off: number, v: number): void {
  mem[off]     =  v        & 0xFF;
  mem[off + 1] = (v >>  8) & 0xFF;
  mem[off + 2] = (v >> 16) & 0xFF;
  mem[off + 3] = (v >> 24) & 0xFF;
}
function read32(mem: Uint8Array, off: number): number {
  return (mem[off] | (mem[off + 1] << 8) | (mem[off + 2] << 16) | (mem[off + 3] << 24)) >>> 0;
}

// Scan main RAM for the OS_ThreadInfo table. Real NitroSDK stores the
// table head pointer at a fixed offset inside the SDK's BSS, which we
// don't have a stable address for — so instead we scan for the first
// struct whose state field is a known OS_THREAD_STATE_* code AND whose
// surrounding bytes plausibly look like an OS_Thread record. Returns
// the MAIN-RAM ADDRESS (0x02xxxxxx) of the first plausible struct, or
// null if no candidates found.
//
// We scan on 4-byte boundaries — NitroSDK aligns every OS_Thread to a
// word boundary (struct contains Uint32 fields).
export function findOsThreadList(mainRam: Uint8Array): number | null {
  // Don't mask the byte offset — main RAM is 4 MB and the scan region
  // can match (or exceed) that. Clamp instead so a 4 MB RAM scan ends
  // at the buffer end, not at zero via wrap-around.
  const lo = Math.max(0, THREAD_SCAN_REGION_LO - MAIN_RAM_BASE);
  const hi = Math.min(
    THREAD_SCAN_REGION_HI - MAIN_RAM_BASE,
    mainRam.length - THREAD_STRUCT_MIN_SIZE,
  );
  for (let off = lo; off <= hi; off += 4) {
    if (looksLikeThread(mainRam, off)) {
      return (MAIN_RAM_BASE + off) >>> 0;
    }
  }
  return null;
}

// Find the first WAITING thread starting from the given main-RAM
// offset. Returns the BYTE OFFSET inside mainRam, not an address —
// the caller already knows the base. Returns -1 on miss.
function findWaitingThread(mainRam: Uint8Array, startOff: number): number {
  const hi = Math.min(
    THREAD_SCAN_REGION_HI - MAIN_RAM_BASE,
    mainRam.length - THREAD_STRUCT_MIN_SIZE,
  );
  for (let off = startOff; off <= hi; off += 4) {
    if (read16(mainRam, off + THREAD_STATE_OFF) === OS_THREAD_STATE_WAITING) {
      return off;
    }
  }
  return -1;
}

// Internal state machine. Tracks ARM9 halt-streak counters, last
// synthesized PC, and the offset of the last thread we kicked (so an
// escalation step picks a DIFFERENT thread next time).
export class NitroOsAssist {
  private emu: Emulator;
  // Number of consecutive frames the ARM9 has been halted in WFI with
  // no plausible wake source. Resets to 0 the moment the CPU does any
  // forward progress.
  private wfiFrames = 0;
  // PC at the moment we synthesized the most recent wakeup. We watch
  // this for PROGRESS_WINDOW frames to decide whether the wake worked.
  private wakePc = 0;
  // Frames remaining in the post-wake observation window.
  private wakeWatch = 0;
  // Byte offset of the last thread we kicked. Resets on every fresh
  // deadlock (so a new lockup starts from the first WAITING thread).
  private lastKickedOff = 0;
  // Diagnostic counter. Tests and the UI's debug panel can read this
  // to confirm the assist did / did not fire against a given ROM.
  synthesizedWakes = 0;
  // Same idea for the secondary assists below.
  syntheticTicks = 0;
  pxiDrains = 0;
  // PXI-overflow detector: number of consecutive frames where the
  // ARM9→ARM7 queue has been at least PXI_DRAIN_THRESHOLD entries
  // AND ARM7 hasn't acked anything. If this hits PXI_DRAIN_FRAMES we
  // synthesize a generic completion-bit ack for the head value to
  // unstick the SDK. Pokemon Diamond/Pearl/Platinum hit this at boot
  // — q9to7 fills to 16 (full) because our static stub-server reply
  // table doesn't cover the tags they send.
  private pxiStuckFrames = 0;

  constructor(emu: Emulator) {
    this.emu = emu;
  }

  // Called once per frame from Emulator.runFrame. The argument is the
  // total frame count since boot — only used for stable monotonic
  // logging in trace builds, the actual decision logic uses our
  // private wfiFrames counter.
  tick(_totalFrames: number): boolean {
    const cpu9 = this.emu.cpu9;
    const irq9 = this.emu.irq9;
    const mem  = this.emu.mem.mainRam;

    // Secondary assists that fire unconditionally per frame (not gated
    // by the CPU's halt state). They write to specific game-state
    // locations that real-DS VBlank handlers would have updated.
    this.tickVBlankTickCounter(mem);
    this.tickPxiDrain();

    // Are we even halted? If not, the deadlock counter resets and we
    // have nothing to do. Also reset the post-wake window — forward
    // progress was made.
    if (!cpu9.state.halted) {
      this.wfiFrames = 0;
      // PC moved a lot since we synthesized → the kick worked. Clear
      // the post-wake observation so the next deadlock starts fresh.
      if (this.wakeWatch > 0) {
        const delta = Math.abs((cpu9.state.r[15] >>> 0) - this.wakePc);
        if (delta > PC_DELTA_GOOD) {
          this.wakeWatch = 0;
          this.lastKickedOff = 0;
        } else {
          this.wakeWatch--;
        }
      }
      return false;
    }

    // Halted. Is something else going to wake the CPU on its own? If
    // an enabled IRQ is queued, IPC traffic is in flight, or DMA is
    // running, we're not deadlocked — just waiting. Don't synthesize.
    if (irq9.wakePending) { this.wfiFrames = 0; return false; }
    if (this.hasPendingWakeSource()) { this.wfiFrames = 0; return false; }

    this.wfiFrames++;
    if (this.wfiFrames < DEADLOCK_FRAMES) return false;

    // Decision time. Walk the OS_Thread region looking for a WAITING
    // thread we haven't already kicked. If we find one, write its
    // wait-condition word and raise an IPCSYNC IRQ to wake the CPU.
    return this.synthesizeWake(mem);
  }

  // Heuristic: any source that could plausibly wake a halted ARM9 in
  // the next frame without our help. We're conservative — false
  // negatives here just mean we wait an extra frame, false positives
  // mean we synthesize a spurious wake.
  private hasPendingWakeSource(): boolean {
    // IPC FIFO has bytes in flight → the IPC IRQ will fire when ARM7
    // drains its queue. Wait it out.
    if (this.emu.ipc.q7to9.size > 0) return true;
    if (this.emu.ipc.q9to7.size > 0) return true;
    // Active DMA channels eventually raise an IRQ on completion.
    for (const ch of this.emu.dma9.channels) if (ch.enabled) return true;
    return false;
  }

  // Find and kick the next WAITING thread. Returns true if we did
  // synthesize a wake this frame.
  private synthesizeWake(mem: Uint8Array): boolean {
    // Where to start scanning. If we already kicked one, start AFTER
    // it so we don't kick the same thread twice in a row (the kick
    // didn't work — try the next candidate).
    const startOff = this.lastKickedOff > 0
      ? this.lastKickedOff + THREAD_STRUCT_MIN_SIZE
      : Math.max(0, THREAD_SCAN_REGION_LO - MAIN_RAM_BASE);
    const threadOff = findWaitingThread(mem, startOff);
    if (threadOff < 0) {
      // Exhausted candidates — wrap to the start so the next attempt
      // re-kicks from the first WAITING thread. Don't spin forever
      // synthesizing wakes that don't help; reset the counter so we
      // wait another DEADLOCK_FRAMES before trying again.
      this.lastKickedOff = 0;
      this.wfiFrames = 0;
      return false;
    }

    // The "wait condition" word is whatever the sleeping thread is
    // expected to see. NitroSDK's convention is that OS_WakeupThread
    // writes the address of the woken thread to the condition word,
    // so the sleeper can check `if (cond == &myThread)`. We follow
    // that convention: write the thread struct's own address into the
    // wait-condition word.
    const threadAddr = (MAIN_RAM_BASE + threadOff) >>> 0;
    const condOff = threadOff + THREAD_WAITING_OFF;
    if (condOff + 4 <= mem.length) {
      write32(mem, condOff, threadAddr);
    }
    // Also flip the state field RUNNABLE so the scheduler picks it.
    mem[threadOff + THREAD_STATE_OFF]     = OS_THREAD_STATE_RUNNABLE & 0xFF;
    mem[threadOff + THREAD_STATE_OFF + 1] = (OS_THREAD_STATE_RUNNABLE >> 8) & 0xFF;

    // Kick the ARM9 out of WFI with an IPCSYNC IRQ. We pick IPCSYNC
    // because the SDK's IRQ handler always re-runs the scheduler on
    // any IRQ return — the specific source doesn't matter to the
    // scheduler, only that an IRQ ran.
    this.emu.irq9.raise(IRQ_IPC_SYNC);

    // Track the kick for the post-wake observation window.
    this.wakePc = this.emu.cpu9.state.r[15] >>> 0;
    this.wakeWatch = PROGRESS_WINDOW;
    this.lastKickedOff = threadOff;
    this.synthesizedWakes++;
    // Reset the WFI streak — even if the kick fails, we want a fresh
    // DEADLOCK_FRAMES wait before kicking the NEXT candidate.
    this.wfiFrames = 0;
    return true;
  }

  // NitroSDK system tick counter lives near the top of Main RAM at
  // 0x02FFFF8C — every VBlank handler bumps the u32 there. LEGO Battles:
  // Ninjago and Plants vs. Zombies both busy-spin on this exact word
  // expecting it to increment; PvZ even runs with IME=False so its own
  // VBlank handler never gets a chance to bump it. We do the bump
  // ourselves once per VBlank IFF the value looks like a counter (small,
  // monotonic) and not, say, a function pointer the game happens to have
  // placed there. Skipping when the value looks pointer-shaped keeps
  // working games (which don't rely on this address) untouched.
  private tickVBlankTickCounter(mem: Uint8Array): void {
    // 0x02FFFF8C lives in the main-RAM mirror window — mask through the
    // 4 MB mirror to get the actual backing-store offset (= 0x3FFF8C).
    const off = SDK_TICK_COUNTER_ADDR & MAIN_RAM_MASK;
    if (off + 4 > mem.length) return;
    const cur = read32(mem, off);
    // Pointer-shaped values (0x02xxxxxx, 0x03xxxxxx, etc.) are clearly
    // not tick counters; small monotonic ones with a high byte of 0 are.
    if (cur > 0x00FFFFFF) return;
    write32(mem, off, (cur + 1) >>> 0);
    this.syntheticTicks++;
  }

  // ARM9 → ARM7 PXI FIFO drain. Pokemon DPPt + family fill q9to7 to 16
  // (full) because our static stub-server reply table only matches a few
  // specific value-shape patterns. Once the queue is full the SDK is
  // stuck in a CNT_SEND_FULL retry loop. If we detect the queue has
  // been at-or-near full for PXI_DRAIN_FRAMES consecutive frames AND no
  // real ARM7 traffic has happened in that window, we synthesize a
  // generic completion-bit ack (`value | 0x20`, the SDK's standard
  // "done" bit) for the head value to unstick the SDK.
  private tickPxiDrain(): void {
    const ipc = this.emu.ipc;
    if (ipc.q9to7.size < PXI_DRAIN_THRESHOLD) {
      this.pxiStuckFrames = 0;
      return;
    }
    this.pxiStuckFrames++;
    if (this.pxiStuckFrames < PXI_DRAIN_FRAMES) return;
    // Drain ONE entry per frame so retries from the SDK can refill the
    // queue at the natural rate (rather than flooding ARM9 with acks).
    const head = ipc.q9to7.peek();
    if (head === null) return;
    ipc.q9to7.pop();
    ipc.queueArm7Ack((head | 0x20) >>> 0);
    this.pxiDrains++;
    // Reset the streak so we wait again before draining the next entry.
    this.pxiStuckFrames = 0;
  }
}

// Free-standing convenience wrapper. Lets callers in tests / debug
// tools invoke the assist without holding a NitroOsAssist instance.
// Returns true iff a wake was synthesized this frame.
export function tryAdvanceDeadlockedSdk(emu: Emulator): boolean {
  if (!emu.nitroOs) return false;
  return emu.nitroOs.tick(emu.ppu.frameCount);
}

// Re-export the size constant so tests can build synthetic thread
// records without copy-pasting the offset.
export const NITRO_THREAD_STRUCT_SIZE = THREAD_STRUCT_MIN_SIZE;
export const NITRO_THREAD_STATE_OFF   = THREAD_STATE_OFF;
export const NITRO_THREAD_WAITING_OFF = THREAD_WAITING_OFF;
