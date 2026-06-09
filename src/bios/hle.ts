// Minimal BIOS high-level emulation. Catches SWIs in the CPU before
// they enter exception mode, services them directly, and returns. Also
// installs a tiny ARM IRQ-dispatch stub in the BIOS memory region so
// any IRQ taken on the real exception vector lands on a working
// dispatcher (and the user IRQ handler at the conventional address gets
// called).
//
// ARM7 SWIs we handle: 0x04 IntrWait, 0x05 VBlankIntrWait, 0x06 Halt,
// 0x09 Divide, 0x0B CpuSet, 0x0C CpuFastSet.
// ARM9 SWIs we handle: 0x04 IntrWait, 0x05 VBlankIntrWait, 0x06 Halt,
// 0x09 Divide, 0x0B CpuSet, 0x0C CpuFastSet, 0x0D Sqrt.

import type { Cpu } from '../cpu/cpu';
import type { Irq } from '../io/irq';

export class BiosHle {
  cpu: Cpu;
  irq: Irq;
  // Pending IntrWait mask — set when a SWI puts the CPU in halt waiting
  // for a specific IRQ subset. The runFrame loop watches this and clears
  // halt + acks IF when a matching bit comes up.
  pendingWaitMask = 0;
  pendingWaitDiscardOld = 0;

  constructor(cpu: Cpu, irq: Irq) {
    this.cpu = cpu;
    this.irq = irq;
  }

  // Called from Cpu.softwareInterrupt. Returns true to skip exception
  // entry (we already handled it).
  handleSwi(comment: number): boolean {
    const s = this.cpu.state;
    // SWI immediate is the low byte of the instruction comment field on
    // both ARM (24-bit) and THUMB (8-bit) — we mask to 0xFF for both.
    const swi = (comment & 0xFF) >>> 0;

    if (this.cpu.isArm9) {
      switch (swi) {
        case 0x04: return this.intrWait(s.r[0], s.r[1]);
        case 0x05: return this.vblankWait();
        case 0x06: s.halted = true; return true;
        case 0x09: { divide(s.r[0] | 0, s.r[1] | 0, s); return true; }
        case 0x0B: cpuSet(this.cpu, s.r[0], s.r[1], s.r[2]); return true;
        case 0x0C: cpuFastSet(this.cpu, s.r[0], s.r[1], s.r[2]); return true;
        case 0x0D: { s.r[0] = Math.floor(Math.sqrt(s.r[0] >>> 0)); return true; }
      }
    } else {
      switch (swi) {
        case 0x04: return this.intrWait(s.r[0], s.r[1]);
        case 0x05: return this.vblankWait();
        case 0x06: s.halted = true; return true;
        case 0x09: { divide(s.r[0] | 0, s.r[1] | 0, s); return true; }
        case 0x0B: cpuSet(this.cpu, s.r[0], s.r[1], s.r[2]); return true;
        case 0x0C: cpuFastSet(this.cpu, s.r[0], s.r[1], s.r[2]); return true;
      }
    }
    // Unhandled — pretend it succeeded (return to user). Better than
    // jumping to vector 0x08 which has no backing memory.
    return true;
  }

  // GBA-style IntrWait: r0 = discardOld, r1 = bitmask. If discardOld
  // and IF & mask is already set, skip wait. Otherwise halt; runFrame
  // wakes us when an IF bit in mask gets raised.
  private intrWait(discardOld: number, mask: number): boolean {
    if (discardOld && (this.irq.if_ & mask) !== 0) {
      this.irq.ackIf(this.irq.if_ & mask);
    }
    this.pendingWaitMask = mask >>> 0;
    this.pendingWaitDiscardOld = discardOld & 1;
    // The real BIOS clears CPSR.I (and sets IME=1) before halting so
    // the IRQ it's waiting for can fire. Games SWI us with I=1 expecting
    // that — without this they halt forever even though the IRQ is
    // pending in IF.
    this.cpu.state.cpsr &= ~0x80;
    this.irq.ime = true;
    this.irq.recache();
    this.cpu.state.halted = true;
    return true;
  }

  private vblankWait(): boolean {
    return this.intrWait(1, 1);
  }

  // Called by the emulator each frame after PPU advance. If the CPU is
  // halted in an IntrWait and a matching IRQ has fired, clear it from IF
  // and unhalt.
  serviceWait(): void {
    if (!this.cpu.state.halted || this.pendingWaitMask === 0) return;
    const fired = this.irq.if_ & this.pendingWaitMask;
    if (fired !== 0) {
      this.irq.ackIf(fired);
      this.cpu.state.halted = false;
      this.pendingWaitMask = 0;
    }
  }
}

// Convert ARM7 SWI 0x09 / ARM9 SWI 0x09: signed 32-bit divide.
// Returns { quot, rem, absQuot } in R0/R1/R3.
function divide(num: number, den: number, s: { r: Uint32Array }): void {
  if (den === 0) {
    s.r[0] = num < 0 ? 0xFFFFFFFF : 1;
    s.r[1] = num >>> 0;
    s.r[3] = Math.abs(num) >>> 0;
    return;
  }
  const q = (num / den) | 0;
  const r = (num - q * den) | 0;
  s.r[0] = q >>> 0;
  s.r[1] = r >>> 0;
  s.r[3] = Math.abs(q) >>> 0;
}

// SWI 0x0B CpuSet — r0=src, r1=dst, r2=length+mode. Mode bits: 0..20 =
// word count; bit 24 = fixed source (fill); bit 26 = 32-bit (else 16).
function cpuSet(cpu: Cpu, src: number, dst: number, mode: number): void {
  const count = mode & 0x1FFFFF;
  const fixed = (mode & 0x01000000) !== 0;
  const word32 = (mode & 0x04000000) !== 0;
  let s = src >>> 0, d = dst >>> 0;
  if (word32) {
    const step = 4;
    for (let i = 0; i < count; i++) {
      const v = cpu.bus.read32(s & ~3);
      cpu.bus.write32(d & ~3, v);
      if (!fixed) s = (s + step) >>> 0;
      d = (d + step) >>> 0;
    }
  } else {
    const step = 2;
    for (let i = 0; i < count; i++) {
      const v = cpu.bus.read16(s & ~1);
      cpu.bus.write16(d & ~1, v);
      if (!fixed) s = (s + step) >>> 0;
      d = (d + step) >>> 0;
    }
  }
}

// SWI 0x0C CpuFastSet — like CpuSet but 32-bit only, 8-word chunks.
function cpuFastSet(cpu: Cpu, src: number, dst: number, mode: number): void {
  const count = mode & 0x1FFFFF;
  const fixed = (mode & 0x01000000) !== 0;
  let s = src >>> 0, d = dst >>> 0;
  for (let i = 0; i < count; i++) {
    const v = cpu.bus.read32(s & ~3);
    cpu.bus.write32(d & ~3, v);
    if (!fixed) s = (s + 4) >>> 0;
    d = (d + 4) >>> 0;
  }
}
