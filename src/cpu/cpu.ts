// Generic ARM core — instantiated twice, once for the ARM9 (v5) and
// once for the ARM7 (v4T). `isArm9` toggles the v5-only decode paths
// (CLZ, BLX, LDRD/STRD, MCR/MRC, POP {PC} interworking).
//
// IRQ-take is HLE'd in JS rather than via the ARM-mode BIOS stub at
// 0x18 — the real Nintendo SDK dispatcher reloads R14 mid-flight from
// a function-pointer table, and getting the stack and SPSR semantics
// exactly right inside an ARM stub turned out to be fragile. Doing the
// equivalent in JS guarantees stack-balance and SPSR restore. The
// in-BIOS stub remains as a fallback for any IRQ taken before HLE is
// attached.

import type { ArmBus } from './bus';
import { CpuState, FLAG_I, FLAG_T, Mode } from './state';
import { armExecute } from './arm';
import { thumbExecute } from './thumb';
import { Cp15 } from './cp15';
import type { BiosHle } from '../bios/hle';

// Magic address the JS-side IRQ HLE sets LR to. When the user IRQ
// handler eventually returns via BX LR, the CPU's next decode lands
// here and we run returnFromIrq() instead of fetching an instruction.
// Picked inside the ARM9 high-vector BIOS region (0xFFFF0000+) to
// avoid collision with any real code; the same value works for ARM7
// (its BIOS sits at 0x00000000 so 0xFFFFxxxx is just unmapped, which
// is fine — we never actually fetch from this address).
export const IRQ_RETURN_MARKER = 0xFFFF1000 | 0;

export class Cpu {
  state = new CpuState();
  bus: ArmBus;
  isArm9: boolean;
  cp15: Cp15 | null = null;
  bios: BiosHle | null = null;
  cycles = 0;
  irqLine = false;
  branched = false;

  constructor(bus: ArmBus, isArm9: boolean) {
    this.bus = bus;
    this.isArm9 = isArm9;
  }

  reset(entryPc: number, sysSp: number, irqSp: number, svcSp: number): void {
    this.state = new CpuState();
    this.state.cpsr = Mode.SVC | FLAG_I | 0x40 /* F */;
    this.state.switchMode(Mode.SYS);
    this.state.r[13] = sysSp >>> 0;
    this.state.bank_r13[2] = irqSp >>> 0;
    this.state.bank_r13[3] = svcSp >>> 0;
    this.state.r[15] = entryPc >>> 0;
  }

  flushPipeline(): void { this.branched = true; }

  step(): number {
    const s = this.state;
    if (s.halted) {
      if (this.irqLine && !(s.cpsr & FLAG_I)) s.halted = false;
      this.cycles += 1;
      return 1;
    }
    if (this.irqLine && !(s.cpsr & FLAG_I)) {
      this.takeIrq();
    }

    const isThumb = (s.cpsr & FLAG_T) !== 0;
    const decode = s.r[15] & (isThumb ? ~1 : ~3);
    // JS-managed IRQ return — when the user IRQ handler chain BX LRs
    // back to our marker, run the JS-side context restore instead of
    // fetching an instruction.
    if (decode === IRQ_RETURN_MARKER) {
      this.returnFromIrq();
      this.cycles += 1;
      return 1;
    }
    // Bad-branch guard: if a BLX/BX target was uninitialized (e.g. a
    // game struct's function pointer slot was zero/garbage, like Brain
    // Training's hit on a heap struct's +8 field), ARM9 would jump
    // outside any valid memory region. Without intervention it'd
    // NOP-sled through unmapped memory (which our bus returns as 0,
    // decoding as conditional NOP) — runaway PC, no game progress.
    // Instead, detect PC in clearly-invalid regions and force a BX LR
    // return so the calling function can recover.
    //
    // ARM7 has BIOS at 0x00000000-0x00003FFF (valid execution region).
    // ARM9 BIOS is at the high vectors only — ARM9 with PC = 0 means a
    // BLX to a NULL function pointer; treat as invalid.
    const lowBound = this.isArm9 ? 0x01000000 : 0;
    const inValid =
      (decode >= lowBound && decode < 0x02400000) ||
      (decode >= 0x03000000 && decode < 0x04000000) ||
      (decode >= 0xFFFF0000);
    if (!inValid) {
      // Simulate BX LR: jump back to caller.
      const lr = s.r[14] >>> 0;
      if (lr & 1) { s.cpsr |= FLAG_T; s.r[15] = lr & ~1; }
      else        { s.cpsr &= ~FLAG_T; s.r[15] = lr & ~3; }
      this.flushPipeline();
      this.cycles += 1;
      return 1;
    }

    const insnSize = isThumb ? 2 : 4;
    const prefetchOff = isThumb ? 4 : 8;
    const instr = isThumb ? this.bus.read16(decode) : this.bus.read32(decode);
    s.r[15] = (decode + prefetchOff) >>> 0;
    this.branched = false;

    if (isThumb) thumbExecute(this, instr);
    else         armExecute(this, instr);

    if (!this.branched) s.r[15] = (decode + insnSize) >>> 0;
    this.cycles += 1;
    return 1;
  }

  softwareInterrupt(comment: number): void {
    if (this.bios && this.bios.handleSwi(comment)) {
      return;
    }
    const s = this.state;
    const inThumb = (s.cpsr & FLAG_T) !== 0;
    const ret = inThumb ? (s.r[15] - 2) >>> 0 : (s.r[15] - 4) >>> 0;
    s.enterException(Mode.SVC, 0x08, ret, false);
    this.flushPipeline();
  }

  // HLE'd IRQ entry. Equivalent ARM-mode sequence:
  //   STMFD SP!, {R0-R3, R12, LR}    (save context to IRQ stack)
  //   LDR R0, [<handler_ptr_addr>]   (read user handler ptr)
  //   ADR LR, RETURN_MARKER          (set LR so handler returns here)
  //   BX R0                          (call handler)
  //   <RETURN_MARKER>:
  //   LDMFD SP!, {R0-R3, R12, LR}
  //   SUBS PC, LR, #4
  takeIrq(): void {
    const s = this.state;
    // The pre-exception PC is the address of the instruction we were
    // about to execute (= what step() will treat as decode next time).
    const savedPc = (s.r[15] + 4) >>> 0;
    s.enterException(Mode.IRQ, 0x18, savedPc, false);

    // Now in IRQ mode — push {R0-R3, R12, LR} to the IRQ stack the same
    // way STMFD SP!, {…} would. ARM block-transfer order: stores low
    // reg at lowest addr; STMFD = decrement-before with writeback.
    let sp = (s.r[13] - 24) >>> 0;
    const start = sp;
    this.bus.write32(sp, s.r[0]); sp = (sp + 4) >>> 0;
    this.bus.write32(sp, s.r[1]); sp = (sp + 4) >>> 0;
    this.bus.write32(sp, s.r[2]); sp = (sp + 4) >>> 0;
    this.bus.write32(sp, s.r[3]); sp = (sp + 4) >>> 0;
    this.bus.write32(sp, s.r[12]); sp = (sp + 4) >>> 0;
    this.bus.write32(sp, s.r[14]); // LR_irq (= savedPc)
    s.r[13] = start;

    // Read user IRQ handler pointer from the conventional address:
    //   ARM7: 0x03FFFFFC (mirror of 0x0380FFFC = end of IWRAM-4)
    //   ARM9: DTCM_END - 4 (DTCM moves; track via Cp15)
    const ptrAddr = this.isArm9 && this.cp15
      ? ((this.cp15.bus9.dtcmBase + this.cp15.bus9.dtcmVirtualSize - 4) >>> 0)
      : 0x03FFFFFC;
    const handler = this.bus.read32(ptrAddr) >>> 0;

    // Set R14 (LR) to the return marker. When user code BX LRs back
    // here, step() catches the marker and runs returnFromIrq().
    s.r[14] = IRQ_RETURN_MARKER >>> 0;

    // Jump to handler (ARM mode — the T bit is already cleared by
    // enterException, and DS handlers are ARM-mode).
    s.r[15] = handler & ~3;
    this.flushPipeline();
  }

  // Pair of takeIrq — pops the saved context off the IRQ stack and
  // returns to the pre-IRQ PC + mode via the SPSR.
  returnFromIrq(): void {
    const s = this.state;
    let sp = s.r[13];
    s.r[0]  = this.bus.read32(sp) >>> 0; sp = (sp + 4) >>> 0;
    s.r[1]  = this.bus.read32(sp) >>> 0; sp = (sp + 4) >>> 0;
    s.r[2]  = this.bus.read32(sp) >>> 0; sp = (sp + 4) >>> 0;
    s.r[3]  = this.bus.read32(sp) >>> 0; sp = (sp + 4) >>> 0;
    s.r[12] = this.bus.read32(sp) >>> 0; sp = (sp + 4) >>> 0;
    const savedLr = this.bus.read32(sp) >>> 0; sp = (sp + 4) >>> 0;
    s.r[13] = sp;
    s.r[14] = savedLr;

    // SUBS PC, LR, #4 equivalent: restore CPSR from SPSR (mode + T flag),
    // then PC = LR - 4 aligned to current ARM/THUMB mode.
    const spsr = s.getSpsr();
    s.switchMode(spsr & 0x1F);
    s.cpsr = spsr >>> 0;
    const result = (savedLr - 4) >>> 0;
    const thumb = (s.cpsr & FLAG_T) !== 0;
    s.r[15] = thumb ? (result & ~1) : (result & ~3);
    this.flushPipeline();
  }

  halt(): void { this.state.halted = true; }
}
