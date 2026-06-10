// Coverage for src/cart/nsmb_fs_assist.ts — the JS-side hook the
// Emulator's runFrame loop fires whenever ARM9 PC enters our shared
// FS-thunk address. The hook reads (handle, dst, src, len) out of R0-R3
// just like the SDK dispatcher's BLX expects to call them, copies ROM
// bytes into the destination buffer in main RAM, clears the FS handle's
// "in progress" bit, sets R0 = 6 ("synchronously completed"), and BX-LRs
// back to the dispatcher.
//
// The ARM-side fallback thunk in src/ppu/ppu.ts (a 5-instruction "clear
// bit 0x200, MOV R0,#6, BX LR" stub) still exists and has its own test
// file (nsmb_fs_thunk.test.ts). The two layers coexist: this assist is
// what actually copies bytes during normal emulation; the inline ARM
// bytes are exercised by Cpu.step-direct tests and as a safety net if
// the assist ever no-ops a call (e.g. one that doesn't look like a read
// request).
//
// Test vectors below are derived from real captures of NSMB at frame
// ~100, when the SDK has stamped the primary "rom\0" handle and the FS
// dispatcher first issues a FNT root-directory read:
//   R0 = 0x02096114 (handle)
//   R1 = 0x027E3764 (dst, in the 0x027xxxxx main-RAM mirror)
//   R2 = 0x00226EA0 (src = FNT base, per the ROM header)
//   R3 = 0x00000008 (8 bytes = FAT root directory record header)
//   LR = 0x02069734 (dispatcher's post-BLX return address)

import { describe, it, expect } from 'vitest';
import { Cpu } from '../cpu/cpu';
import { Bus9 } from '../memory/bus9';
import { SharedMemory } from '../memory/shared';
import {
  performNsmbFsRead,
  tryHandleNsmbFsThunk,
  NSMB_FS_THUNK_ADDR,
} from '../cart/nsmb_fs_assist';

function makeCpu(): { cpu: Cpu; mem: SharedMemory } {
  const mem = new SharedMemory();
  const bus = new Bus9(mem);
  const cpu = new Cpu(bus, true);
  cpu.reset(NSMB_FS_THUNK_ADDR, 0x0380FF00, 0x0380FFA0, 0x0380FFE0);
  return { cpu, mem };
}

// Build a fake "ROM" with a deterministic byte pattern so we can verify
// the right bytes ended up at the right offset in main RAM. We do NOT
// load a real NDS image — the assist only touches the raw byte arrays.
function makeRom(size: number): Uint8Array {
  const r = new Uint8Array(size);
  for (let i = 0; i < size; i++) r[i] = (i * 31) & 0xFF;
  return r;
}

describe('NSMB FS assist', () => {
  it('copies the FNT root record from ROM to main-RAM mirror', () => {
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x2000000);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x027E3764;
    cpu.state.r[2]  = 0x00226EA0;
    cpu.state.r[3]  = 0x00000008;
    cpu.state.r[14] = 0x02069734;
    cpu.state.r[15] = NSMB_FS_THUNK_ADDR;

    const ok = performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam });

    expect(ok).toBe(true);
    expect(cpu.state.r[0]).toBe(6);
    // PC should now point at LR (returned BX LR).
    expect(cpu.state.r[15]).toBe(0x02069734);
    // Destination buffer at the 0x027xxxxx alias maps onto the same
    // 4 MB store as 0x023xxxxx — the mask resolves both to physical
    // offset 0x3E3764 inside the mainRam array.
    const dstOff = 0x027E3764 & 0x3FFFFF;
    for (let i = 0; i < 8; i++) {
      expect(mem.mainRam[dstOff + i]).toBe(rom[0x226EA0 + i]);
    }
    // The byte just past the requested range stays zero — assist
    // copies exactly R3 bytes, no overspill into adjacent struct
    // fields the dispatcher cares about.
    expect(mem.mainRam[dstOff + 8]).toBe(0);
  });

  it('clears the FS handle state-word "in progress" bit (0x200)', () => {
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x1000);
    // Pre-stamp the handle's state word at handle+0x1C with the
    // dispatcher's busy-marker pattern (0x213 = 0x200 | 0x13). The
    // assist must clear 0x200 and leave the rest intact.
    const stateOff = (0x02096114 + 0x1C) & 0x3FFFFF;
    mem.mainRam[stateOff]     = 0x13;
    mem.mainRam[stateOff + 1] = 0x02;
    mem.mainRam[stateOff + 2] = 0x00;
    mem.mainRam[stateOff + 3] = 0x00;
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x02100000;
    cpu.state.r[2]  = 0x10;
    cpu.state.r[3]  = 8;
    cpu.state.r[14] = 0x02000000;

    performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam });

    expect(mem.mainRam[stateOff])     .toBe(0x13);
    expect(mem.mainRam[stateOff + 1]) .toBe(0x00);
  });

  it('rejects calls whose src offset is past ROM end', () => {
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x10000);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x027E3764;
    cpu.state.r[2]  = 0x00100000;   // past ROM end
    cpu.state.r[3]  = 0x10;
    cpu.state.r[14] = 0x02069734;
    cpu.state.r[15] = NSMB_FS_THUNK_ADDR;

    const ok = performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam });

    expect(ok).toBe(false);
    // R0 unchanged — assist did NOT touch register state on failure.
    expect(cpu.state.r[0]).toBe(0x02096114);
    // PC unchanged — assist did NOT BX-LR on failure, leaving the
    // inline ARM thunk to handle the call (which the emulator's
    // runFrame loop will fire on the next step).
    expect(cpu.state.r[15]).toBe(NSMB_FS_THUNK_ADDR);
    // Destination buffer is still zeroed — no partial writes.
    const dstOff = 0x027E3764 & 0x3FFFFF;
    expect(mem.mainRam[dstOff]).toBe(0);
  });

  it('rejects calls whose dst pointer is not in the main-RAM region', () => {
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x10000);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x06000000;   // VRAM, not main RAM
    cpu.state.r[2]  = 0x00001000;
    cpu.state.r[3]  = 0x10;
    cpu.state.r[14] = 0x02069734;

    const ok = performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam });

    expect(ok).toBe(false);
  });

  it('rejects calls with zero length', () => {
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x10000);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x027E3764;
    cpu.state.r[2]  = 0x00001000;
    cpu.state.r[3]  = 0;
    cpu.state.r[14] = 0x02069734;

    expect(performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam })).toBe(false);
  });

  it('rejects calls with absurdly large length (struct misinterpretation)', () => {
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x10000);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x027E3764;
    cpu.state.r[2]  = 0x00001000;
    cpu.state.r[3]  = 0xFFFFFFFF;
    cpu.state.r[14] = 0x02069734;

    expect(performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam })).toBe(false);
  });

  it('rejects when length would wrap past 4 MB inside a mirror slice', () => {
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x1000000);
    // Dst = 0x023FFFF0 (last 16 bytes of physical main RAM). A
    // 32-byte read would wrap to offset 0 — silently corrupting the
    // start of main RAM. Assist must say no.
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x023FFFF0;
    cpu.state.r[2]  = 0x00001000;
    cpu.state.r[3]  = 0x20;
    cpu.state.r[14] = 0x02069734;

    expect(performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam })).toBe(false);
  });

  it('tryHandleNsmbFsThunk only fires when PC equals the thunk address', () => {
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x10000);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x027E3764;
    cpu.state.r[2]  = 0x00001000;
    cpu.state.r[3]  = 8;
    cpu.state.r[14] = 0x02069734;

    // PC not at thunk — no-op.
    cpu.state.r[15] = 0x02000000;
    expect(tryHandleNsmbFsThunk(cpu, { rom, mainRam: mem.mainRam })).toBe(false);
    expect(cpu.state.r[0]).toBe(0x02096114);

    // PC at thunk — fires.
    cpu.state.r[15] = NSMB_FS_THUNK_ADDR;
    expect(tryHandleNsmbFsThunk(cpu, { rom, mainRam: mem.mainRam })).toBe(true);
    expect(cpu.state.r[0]).toBe(6);
  });

  it('returns to a Thumb-mode LR by setting CPSR.T and PC = LR & ~1', () => {
    // The dispatcher in NSMB is ARM-mode and BLX's its callback with an
    // ARM-mode LR, so this is defensive coverage — but BX's LR-bit-0
    // semantics are part of the contract. If a future caller jumps into
    // the thunk from Thumb code, we have to flip CPSR.T back.
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x10000);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x027E3764;
    cpu.state.r[2]  = 0x00001000;
    cpu.state.r[3]  = 8;
    cpu.state.r[14] = 0x0206aa01;    // Thumb-tagged LR (bit 0 set)
    cpu.state.cpsr &= ~0x20;         // start in ARM

    performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam });

    expect(cpu.state.r[15]).toBe(0x0206aa00); // bit 0 stripped
    expect(cpu.state.cpsr & 0x20).toBe(0x20); // FLAG_T now set
  });

  it('returns to an ARM-mode LR by clearing CPSR.T and PC = LR & ~3', () => {
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x10000);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x027E3764;
    cpu.state.r[2]  = 0x00001000;
    cpu.state.r[3]  = 8;
    cpu.state.r[14] = 0x02069734;
    cpu.state.cpsr |= 0x20;           // pretend we're in Thumb

    performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam });

    expect(cpu.state.r[15]).toBe(0x02069734);
    expect(cpu.state.cpsr & 0x20).toBe(0);
  });

  it('marks the CPU as having branched so step() does not advance PC', () => {
    // The Cpu.step contract: if cpu.branched is true at the end of a
    // step, the post-execute "PC += insnSize" path is skipped. Our hook
    // runs BEFORE step (inside Emulator.runFrame), so to keep the next
    // step from advancing PC from LR to LR+4 by accident, we set the
    // flag — Cpu.step also sets it via flushPipeline on real branches.
    const { cpu, mem } = makeCpu();
    const rom = makeRom(0x10000);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x027E3764;
    cpu.state.r[2]  = 0x00001000;
    cpu.state.r[3]  = 8;
    cpu.state.r[14] = 0x02069734;
    cpu.branched = false;

    performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam });

    expect(cpu.branched).toBe(true);
  });

  it('zero-pads the destination tail if src+len overruns the ROM end', () => {
    const { cpu, mem } = makeCpu();
    // Tiny ROM so the read necessarily runs off the end.
    const rom = new Uint8Array(0x100);
    for (let i = 0; i < rom.length; i++) rom[i] = 0xAA;
    // Dirty the destination so we can prove the tail is zeroed (not
    // just left at whatever was there before).
    const dstOff = 0x027E3764 & 0x3FFFFF;
    mem.mainRam.fill(0xDD, dstOff, dstOff + 0x20);
    cpu.state.r[0]  = 0x02096114;
    cpu.state.r[1]  = 0x027E3764;
    cpu.state.r[2]  = 0xF0;     // 0xF0..0xFF have data, 0x100+ doesn't
    cpu.state.r[3]  = 0x20;     // ask for 32 bytes
    cpu.state.r[14] = 0x02069734;

    performNsmbFsRead(cpu, { rom, mainRam: mem.mainRam });

    // First 16 bytes come from ROM.
    for (let i = 0; i < 16; i++) expect(mem.mainRam[dstOff + i]).toBe(0xAA);
    // Last 16 bytes are zero-padded.
    for (let i = 16; i < 32; i++) expect(mem.mainRam[dstOff + i]).toBe(0);
  });
});
