import { CpuState, FLAG_T, Mode } from './state';
import { immShift, regShift, rorImm32, applyCarry } from './shifter';
import type { Cpu } from './cpu';

// Adapted from gba-recomp arm.ts (verbatim base) + ARMv5TE additions for
// ARM9: CLZ, BLX(1)/(2), LDRD/STRD, MCR/MRC (CP15), PLD as nop, BKPT,
// and QADD/QSUB-family (DSP). The ARM7 path leaves the v5 extensions
// off — they decode as undefined.

function addSetFlags(s: CpuState, a: number, b: number): number {
  const r = (a + b) >>> 0;
  s.setNZ(r);
  s.setC(r < a >>> 0);
  s.setV(((~(a ^ b) & (a ^ r)) & 0x80000000) !== 0);
  return r;
}
function adcSetFlags(s: CpuState, a: number, b: number, cIn: number): number {
  const sum = a + b + cIn;
  const r = sum >>> 0;
  s.setNZ(r);
  s.setC(sum > 0xFFFFFFFF);
  s.setV(((~(a ^ b) & (a ^ r)) & 0x80000000) !== 0);
  return r;
}
function subSetFlags(s: CpuState, a: number, b: number): number {
  const r = (a - b) >>> 0;
  s.setNZ(r);
  s.setC(a >>> 0 >= b >>> 0);
  s.setV((((a ^ b) & (a ^ r)) & 0x80000000) !== 0);
  return r;
}
function sbcSetFlags(s: CpuState, a: number, b: number, cIn: number): number {
  const notC = cIn ^ 1;
  const r = (a - b - notC) >>> 0;
  s.setNZ(r);
  s.setC((a >>> 0) >= ((b >>> 0) + notC));
  s.setV((((a ^ b) & (a ^ r)) & 0x80000000) !== 0);
  return r;
}

export function armExecute(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const cond = (instr >>> 28) & 0xF;

  // v5 unconditional space (cond == 0xF). On ARM9 this is BLX(1) imm.
  if (cond === 0xF) {
    if (cpu.isArm9 && ((instr >>> 25) & 0b111) === 0b101) {
      // BLX(1): LR = next ARM PC, target = PC + 8 + signExt(offset24)<<2 + H<<1, T = 1.
      let off = instr & 0x00FFFFFF;
      if (off & 0x00800000) off |= 0xFF000000;
      const h = (instr >>> 24) & 1;
      s.r[14] = (s.r[15] - 4) >>> 0;
      const target = (s.r[15] + (off << 2) + (h << 1)) >>> 0;
      s.cpsr |= FLAG_T;
      s.r[15] = target & ~1;
      cpu.flushPipeline();
      return;
    }
    // PLD (preload data) — treat as nop. Any other unconditional code is
    // undefined, but PLD is the only one we actually see in practice.
    return;
  }

  if (cond !== 0xE && !s.checkCond(cond)) return;

  // Branch and Branch with Link.
  if ((instr & 0x0E000000) === 0x0A000000) {
    let offset = (instr & 0x00FFFFFF) << 2;
    if (offset & 0x02000000) offset |= 0xFC000000;
    if (instr & 0x01000000) s.r[14] = (s.r[15] - 4) >>> 0;
    s.r[15] = (s.r[15] + offset) >>> 0;
    cpu.flushPipeline();
    return;
  }

  // BX / BLX(2) — both share the same prefix 0001 0010 1111 1111 1111.
  if ((instr & 0x0FFFFFD0) === 0x012FFF10) {
    const link = (instr & 0x20) !== 0;
    const rn = instr & 0xF;
    const tgt = s.r[rn];
    if (link) {
      if (!cpu.isArm9) {
        // ARM7 has no BLX(2). Fall through to "undefined" — but as a
        // pragmatic stub we treat it as plain BX.
      } else {
        s.r[14] = (s.r[15] - 4) >>> 0;
      }
    }
    if (tgt & 1) { s.cpsr |= FLAG_T; s.r[15] = tgt & ~1; }
    else         { s.cpsr &= ~FLAG_T; s.r[15] = tgt & ~3; }
    cpu.flushPipeline();
    return;
  }

  // CLZ (ARMv5+).
  if (cpu.isArm9 && (instr & 0x0FFF0FF0) === 0x016F0F10) {
    const rm = instr & 0xF;
    const rd = (instr >>> 12) & 0xF;
    const v = s.r[rm] >>> 0;
    let n = 32;
    if (v !== 0) {
      n = 0;
      let x = v;
      if (!(x & 0xFFFF0000)) { n += 16; x <<= 16; }
      if (!(x & 0xFF000000)) { n += 8;  x <<= 8;  }
      if (!(x & 0xF0000000)) { n += 4;  x <<= 4;  }
      if (!(x & 0xC0000000)) { n += 2;  x <<= 2;  }
      if (!(x & 0x80000000)) { n += 1;             }
    }
    s.r[rd] = n;
    return;
  }

  // ARMv5 DSP saturation arithmetic (QADD / QSUB / QDADD / QDSUB).
  //   bits 27:24=0001, bit 23=0, bit 20=0, bits 7:4=0101.
  if (cpu.isArm9 && (instr & 0x0F9000F0) === 0x01000050) {
    armSaturation(cpu, instr);
    return;
  }
  // ARMv5 DSP halfword multiplies (SMLAxy / SMLAWy / SMULWy / SMLALxy
  // / SMULxy). bits 27:24=0001, bit 23=0, bit 20=0, bit 7=1, bit 4=0.
  if (cpu.isArm9 && (instr & 0x0F900090) === 0x01000080) {
    armDspMultiply(cpu, instr);
    return;
  }

  // MCR / MRC — CP15 access on ARM9. The ARM7 has no CP15; we still
  // accept the decode to avoid spurious "undefined" traps.
  if ((instr & 0x0F000010) === 0x0E000010) {
    const isRead = (instr & 0x00100000) !== 0;
    const cpNum = (instr >>> 8) & 0xF;
    const opc1 = (instr >>> 21) & 0x7;
    const opc2 = (instr >>> 5) & 0x7;
    const crn = (instr >>> 16) & 0xF;
    const crm = instr & 0xF;
    const rd = (instr >>> 12) & 0xF;
    if (cpu.isArm9 && cpNum === 15 && cpu.cp15) {
      if (isRead) {
        s.r[rd] = cpu.cp15.read(opc1, crn, crm, opc2) >>> 0;
      } else {
        cpu.cp15.write(opc1, crn, crm, opc2, s.r[rd] >>> 0);
      }
    }
    return;
  }

  // CDP (coprocessor data operation) + LDC/STC (coprocessor memory).
  // Real ARM9 raises Undefined on any of these for an unimplemented
  // coprocessor (which on the DS is all of them except CP15). We treat
  // as NOP so the game doesn't end up with PC corrupted by an
  // accidentally-misdecoded data-processing instruction. (Pokemon
  // Platinum's compiler emits a CP6 CDP that, if mis-decoded as ADC
  // R15, jumps off the world.)
  if ((instr & 0x0F000010) === 0x0E000000) return;       // CDP
  if ((instr & 0x0E000000) === 0x0C000000) return;       // LDC/STC + MCRR/MRRC

  // SWI
  if ((instr & 0x0F000000) === 0x0F000000) {
    cpu.softwareInterrupt((instr & 0x00FFFFFF) >>> 0);
    return;
  }

  // LDM / STM
  if ((instr & 0x0E000000) === 0x08000000) {
    armBlockTransfer(cpu, instr);
    return;
  }

  // Single data transfer LDR/STR
  if ((instr & 0x0C000000) === 0x04000000) {
    armSingleTransfer(cpu, instr);
    return;
  }

  // Halfword / signed transfer / multiply / swap — extension space.
  if ((instr & 0x0E000090) === 0x00000090) {
    const isHW = (instr & 0x60) !== 0;
    if (isHW) {
      // ARMv5: LDRD/STRD share the halfword decode space (bit 20 = 0,
      // bits 6:5 = 10 or 11). Funnel them off first.
      const op = (instr >>> 5) & 3;
      const L = (instr & 0x00100000) !== 0;
      if (cpu.isArm9 && !L && (op === 2 || op === 3)) {
        armDoubleTransfer(cpu, instr, op === 3 /* store? */);
        return;
      }
      armHalfTransfer(cpu, instr);
      return;
    }
    if ((instr & 0x01000000) === 0) {
      armMultiply(cpu, instr);
      return;
    }
    armSwap(cpu, instr);
    return;
  }

  // MRS / MSR
  if ((instr & 0x0F900000) === 0x01000000 && (instr & 0x90) !== 0x90) {
    if (instr & 0x00200000) { armMsr(cpu, instr); return; }
    armMrs(cpu, instr); return;
  }
  if ((instr & 0x0FB00000) === 0x03200000) {
    armMsrImm(cpu, instr); return;
  }

  // Data processing
  armDataProcessing(cpu, instr);
}

function armDataProcessing(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const opcode = (instr >>> 21) & 0xF;
  const setFlags = (instr & 0x00100000) !== 0;
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;
  let op1 = s.r[rn];
  let op2: number;
  let shifterCarry = s.c();

  if (instr & 0x02000000) {
    const imm = instr & 0xFF;
    const rot = ((instr >>> 8) & 0xF) << 1;
    op2 = rorImm32(imm, rot);
    if (rot !== 0 && setFlags) shifterCarry = (op2 >>> 31) & 1;
  } else {
    const rm = instr & 0xF;
    const shiftType = (instr >>> 5) & 3;
    let rmVal = s.r[rm];
    if (instr & 0x10) {
      const rs = (instr >>> 8) & 0xF;
      const amount = s.r[rs] & 0xFF;
      if (rn === 15) op1 = (op1 + 4) >>> 0;
      if (rm === 15) rmVal = (rmVal + 4) >>> 0;
      const r = regShift(shiftType, amount, rmVal, shifterCarry);
      op2 = r.value;
      shifterCarry = r.carry;
    } else {
      const imm = (instr >>> 7) & 0x1F;
      const r = immShift(shiftType, imm, rmVal, shifterCarry);
      op2 = r.value;
      shifterCarry = r.carry;
    }
  }

  let result = 0;
  let writeResult = true;
  const cIn = s.c();
  switch (opcode) {
    case 0x0: result = (op1 & op2) >>> 0; if (setFlags) { s.setNZ(result); applyCarry(s, shifterCarry); } break;
    case 0x1: result = (op1 ^ op2) >>> 0; if (setFlags) { s.setNZ(result); applyCarry(s, shifterCarry); } break;
    case 0x2: result = setFlags ? subSetFlags(s, op1, op2) : (op1 - op2) >>> 0; break;
    case 0x3: result = setFlags ? subSetFlags(s, op2, op1) : (op2 - op1) >>> 0; break;
    case 0x4: result = setFlags ? addSetFlags(s, op1, op2) : (op1 + op2) >>> 0; break;
    case 0x5: result = setFlags ? adcSetFlags(s, op1, op2, cIn) : (op1 + op2 + cIn) >>> 0; break;
    case 0x6: result = setFlags ? sbcSetFlags(s, op1, op2, cIn) : (op1 - op2 - (cIn ^ 1)) >>> 0; break;
    case 0x7: result = setFlags ? sbcSetFlags(s, op2, op1, cIn) : (op2 - op1 - (cIn ^ 1)) >>> 0; break;
    case 0x8: writeResult = false; result = (op1 & op2) >>> 0; s.setNZ(result); applyCarry(s, shifterCarry); break;
    case 0x9: writeResult = false; result = (op1 ^ op2) >>> 0; s.setNZ(result); applyCarry(s, shifterCarry); break;
    case 0xA: writeResult = false; subSetFlags(s, op1, op2); break;
    case 0xB: writeResult = false; addSetFlags(s, op1, op2); break;
    case 0xC: result = (op1 | op2) >>> 0; if (setFlags) { s.setNZ(result); applyCarry(s, shifterCarry); } break;
    case 0xD: result = op2 >>> 0; if (setFlags) { s.setNZ(result); applyCarry(s, shifterCarry); } break;
    case 0xE: result = (op1 & ~op2) >>> 0; if (setFlags) { s.setNZ(result); applyCarry(s, shifterCarry); } break;
    case 0xF: result = (~op2) >>> 0; if (setFlags) { s.setNZ(result); applyCarry(s, shifterCarry); } break;
  }

  if (writeResult) {
    if (rd === 15) {
      if (setFlags) {
        const spsr = s.getSpsr();
        s.switchMode(spsr & 0x1F);
        s.cpsr = spsr >>> 0;
      }
      const thumb = (s.cpsr & FLAG_T) !== 0;
      s.r[15] = thumb ? (result & ~1) : (result & ~3);
      cpu.flushPipeline();
    } else {
      s.r[rd] = result >>> 0;
    }
  }
}

function armMrs(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const rd = (instr >>> 12) & 0xF;
  s.r[rd] = (instr & 0x00400000) ? s.getSpsr() : s.cpsr >>> 0;
}
function armMsr(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const isSpsr = (instr & 0x00400000) !== 0;
  const val = s.r[instr & 0xF];
  applyMsr(s, isSpsr, instr, val);
}
function armMsrImm(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const isSpsr = (instr & 0x00400000) !== 0;
  const imm = instr & 0xFF;
  const rot = ((instr >>> 8) & 0xF) << 1;
  const val = rorImm32(imm, rot);
  applyMsr(s, isSpsr, instr, val);
}
function applyMsr(s: CpuState, isSpsr: boolean, instr: number, val: number): void {
  let mask = 0;
  if (instr & 0x00010000) mask |= 0x000000FF;
  if (instr & 0x00020000) mask |= 0x0000FF00;
  if (instr & 0x00040000) mask |= 0x00FF0000;
  if (instr & 0x00080000) mask |= 0xFF000000;
  if (isSpsr) {
    s.setSpsr((s.getSpsr() & ~mask) | (val & mask));
    return;
  }
  if (s.mode() === Mode.USR) mask &= 0xFF000000;
  const newCpsr = (s.cpsr & ~mask) | (val & mask);
  const newMode = newCpsr & 0x1F;
  if ((newMode !== s.mode())) s.switchMode(newMode);
  s.cpsr = newCpsr >>> 0;
}

function armSingleTransfer(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const I = (instr & 0x02000000) !== 0;
  const P = (instr & 0x01000000) !== 0;
  const U = (instr & 0x00800000) !== 0;
  const B = (instr & 0x00400000) !== 0;
  const W = (instr & 0x00200000) !== 0;
  const L = (instr & 0x00100000) !== 0;
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;

  const base = s.r[rn];
  let offset: number;
  if (I) {
    const rm = instr & 0xF;
    const shiftType = (instr >>> 5) & 3;
    const imm = (instr >>> 7) & 0x1F;
    offset = immShift(shiftType, imm, s.r[rm], s.c()).value;
  } else {
    offset = instr & 0xFFF;
  }
  const eff = U ? (base + offset) >>> 0 : (base - offset) >>> 0;
  const addr = P ? eff : base;
  const writeback = !P || W;

  if (L) {
    let value: number;
    if (B) {
      value = cpu.bus.read8(addr) >>> 0;
    } else {
      const aligned = cpu.bus.read32(addr & ~3) >>> 0;
      const rot = (addr & 3) << 3;
      value = rot ? ((aligned >>> rot) | (aligned << (32 - rot))) >>> 0 : aligned;
    }
    if (writeback && (!L || rn !== rd)) s.r[rn] = eff >>> 0;
    if (rd === 15) {
      // ARMv5 LDR PC interworking: bit 0 selects THUMB.
      if (cpu.isArm9 && (value & 1)) {
        s.cpsr |= FLAG_T;
        s.r[15] = value & ~1;
      } else {
        s.r[15] = value & ~3;
      }
      cpu.flushPipeline();
    } else {
      s.r[rd] = value >>> 0;
    }
  } else {
    let val = s.r[rd];
    if (rd === 15) val = (val + 4) >>> 0;
    if (B) cpu.bus.write8(addr, val & 0xFF);
    else   cpu.bus.write32(addr & ~3, val >>> 0);
    if (writeback) s.r[rn] = eff >>> 0;
  }
}

function armHalfTransfer(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const P = (instr & 0x01000000) !== 0;
  const U = (instr & 0x00800000) !== 0;
  const I = (instr & 0x00400000) !== 0;
  const W = (instr & 0x00200000) !== 0;
  const L = (instr & 0x00100000) !== 0;
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;
  const sh = (instr >>> 5) & 3;

  const base = s.r[rn];
  let offset: number;
  if (I) offset = ((instr >>> 4) & 0xF0) | (instr & 0xF);
  else   offset = s.r[instr & 0xF];

  const eff = U ? (base + offset) >>> 0 : (base - offset) >>> 0;
  const addr = P ? eff : base;
  const writeback = !P || W;

  if (L) {
    let value = 0;
    switch (sh) {
      case 1: {
        const aligned = cpu.bus.read16(addr & ~1);
        value = (addr & 1) ? ((aligned >>> 8) | (aligned << 24)) >>> 0 : aligned;
        break;
      }
      case 2: {
        const b = cpu.bus.read8(addr);
        value = (b & 0x80) ? (b | 0xFFFFFF00) >>> 0 : b;
        break;
      }
      case 3: {
        if (addr & 1) {
          const b = cpu.bus.read8(addr);
          value = (b & 0x80) ? (b | 0xFFFFFF00) >>> 0 : b;
        } else {
          const h = cpu.bus.read16(addr & ~1);
          value = (h & 0x8000) ? (h | 0xFFFF0000) >>> 0 : h;
        }
        break;
      }
    }
    if (writeback && rn !== rd) s.r[rn] = eff >>> 0;
    if (rd === 15) { s.r[15] = value & ~3; cpu.flushPipeline(); }
    else s.r[rd] = value >>> 0;
  } else {
    if (sh === 1) cpu.bus.write16(addr & ~1, s.r[rd] & 0xFFFF);
    if (writeback) s.r[rn] = eff >>> 0;
  }
}

// ARMv5: LDRD / STRD — paired register transfers, Rd must be even, the
// pair is (Rd, Rd+1). Bit 6 = 0 → load, bit 6 = 1 → store. The pair is
// distinguished from LDRSB/LDRSH only by the L bit being 0 (writes
// can't be sign-extended loads).
function armDoubleTransfer(cpu: Cpu, instr: number, isStore: boolean): void {
  const s = cpu.state;
  const P = (instr & 0x01000000) !== 0;
  const U = (instr & 0x00800000) !== 0;
  const I = (instr & 0x00400000) !== 0;
  const W = (instr & 0x00200000) !== 0;
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;

  const base = s.r[rn];
  let offset: number;
  if (I) offset = ((instr >>> 4) & 0xF0) | (instr & 0xF);
  else   offset = s.r[instr & 0xF];
  const eff = U ? (base + offset) >>> 0 : (base - offset) >>> 0;
  const addr = P ? eff : base;
  const writeback = !P || W;

  if (isStore) {
    cpu.bus.write32(addr & ~3, s.r[rd] >>> 0);
    cpu.bus.write32((addr + 4) & ~3, s.r[rd + 1] >>> 0);
  } else {
    s.r[rd]     = cpu.bus.read32(addr & ~3) >>> 0;
    s.r[rd + 1] = cpu.bus.read32((addr + 4) & ~3) >>> 0;
  }
  if (writeback) s.r[rn] = eff >>> 0;
}

function armMultiply(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const isLong = (instr & 0x00800000) !== 0;
  const setFlags = (instr & 0x00100000) !== 0;
  const accumulate = (instr & 0x00200000) !== 0;
  const rd = (instr >>> 16) & 0xF;
  const rn = (instr >>> 12) & 0xF;
  const rs = (instr >>> 8) & 0xF;
  const rm = instr & 0xF;

  if (!isLong) {
    let r = Math.imul(s.r[rm], s.r[rs]) >>> 0;
    if (accumulate) r = (r + s.r[rn]) >>> 0;
    s.r[rd] = r;
    if (setFlags) s.setNZ(r);
    return;
  }

  const signed = (instr & 0x00400000) !== 0;
  const a = s.r[rm];
  const b = s.r[rs];
  let hi: number, lo: number;
  if (signed) {
    const a32 = a | 0, b32 = b | 0;
    const big = BigInt(a32) * BigInt(b32);
    lo = Number(big & 0xFFFFFFFFn) >>> 0;
    hi = Number((big >> 32n) & 0xFFFFFFFFn) >>> 0;
  } else {
    const big = BigInt(a >>> 0) * BigInt(b >>> 0);
    lo = Number(big & 0xFFFFFFFFn) >>> 0;
    hi = Number((big >> 32n) & 0xFFFFFFFFn) >>> 0;
  }
  if (accumulate) {
    const accLo = s.r[rn];
    const accHi = s.r[rd];
    const sumLo = (lo + accLo) >>> 0;
    const carry = sumLo < lo >>> 0 ? 1 : 0;
    const sumHi = (hi + accHi + carry) >>> 0;
    lo = sumLo; hi = sumHi;
  }
  s.r[rn] = lo;
  s.r[rd] = hi;
  if (setFlags) s.setNZ64Hi(hi, lo);
}

// ---------------------------------------------------------------- saturation
// Sticky Q flag = CPSR bit 27.
const FLAG_Q = 0x08000000 | 0;

function sat32(value: number): { v: number; saturated: boolean } {
  if (value > 0x7FFFFFFF) return { v: 0x7FFFFFFF, saturated: true };
  if (value < -0x80000000) return { v: 0x80000000 | 0, saturated: true };
  return { v: value, saturated: false };
}

function armSaturation(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const op = (instr >>> 21) & 0x3;     // 00=QADD, 01=QSUB, 10=QDADD, 11=QDSUB
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;
  const rm = instr & 0xF;
  const a = s.r[rm] | 0;
  const b = s.r[rn] | 0;
  let result = 0, saturated = false;
  switch (op) {
    case 0: {                                                  // QADD: Rd = sat(Rm + Rn)
      const r = sat32(a + b);
      result = r.v; saturated = r.saturated;
      break;
    }
    case 1: {                                                  // QSUB: Rd = sat(Rm - Rn)
      const r = sat32(a - b);
      result = r.v; saturated = r.saturated;
      break;
    }
    case 2: {                                                  // QDADD: Rd = sat(Rm + sat(2*Rn))
      const dbl = sat32(b * 2);
      const r = sat32(a + dbl.v);
      result = r.v; saturated = r.saturated || dbl.saturated;
      break;
    }
    case 3: {                                                  // QDSUB: Rd = sat(Rm - sat(2*Rn))
      const dbl = sat32(b * 2);
      const r = sat32(a - dbl.v);
      result = r.v; saturated = r.saturated || dbl.saturated;
      break;
    }
  }
  s.r[rd] = result >>> 0;
  if (saturated) s.cpsr |= FLAG_Q;
}

// ---------------------------------------------------------------- DSP multiplies
function armDspMultiply(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const op = (instr >>> 21) & 0x3;   // 00=SMLAxy 01=SMLAW/SMULW 10=SMLALxy 11=SMULxy
  const rdHi = (instr >>> 16) & 0xF; // For SMLA/SMLAL/SMUL/W also serves as Rd
  const rn   = (instr >>> 12) & 0xF; // For SMLA/SMLAL: Rn (accumulator low). For SMUL/W: 0 (SBZ).
  const rs   = (instr >>> 8) & 0xF;
  const x    = (instr >>> 5) & 1;    // For Rm half (low/high)
  const y    = (instr >>> 6) & 1;    // For Rs half
  const rm   = instr & 0xF;

  const rmVal = s.r[rm];
  const rsVal = s.r[rs];
  const rmHalf = (x ? (rmVal >> 16) : (rmVal << 16) >> 16) | 0;   // sign-extended 16-bit
  const rsHalf = (y ? (rsVal >> 16) : (rsVal << 16) >> 16) | 0;

  switch (op) {
    case 0x0: {                                                  // SMLAxy
      const product = Math.imul(rmHalf, rsHalf);
      const acc = s.r[rn] | 0;
      const sum = (product + acc) | 0;
      // Detect 32-bit signed overflow: if product and acc have same sign
      // but sum's sign flips, that's overflow.
      const overflow = (((product ^ sum) & (acc ^ sum)) < 0);
      if (overflow) s.cpsr |= FLAG_Q;
      s.r[rdHi] = sum >>> 0;
      break;
    }
    case 0x1: {                                                  // SMLAWy / SMULWy
      // Rm full 32-bit signed × Rs half (selected by y), take top 32 of
      // result (i.e., shift right 16 with sign extension).
      const big = BigInt(rmVal | 0) * BigInt(rsHalf);
      const product32 = Number(BigInt.asIntN(48, big >> 16n)) | 0;
      if (x === 0) {
        // SMLAWy: + Rn, set Q on overflow
        const acc = s.r[rn] | 0;
        const sum = (product32 + acc) | 0;
        const overflow = (((product32 ^ sum) & (acc ^ sum)) < 0);
        if (overflow) s.cpsr |= FLAG_Q;
        s.r[rdHi] = sum >>> 0;
      } else {
        // SMULWy: just Rd = top 32 of (Rm × Rs.y)
        s.r[rdHi] = product32 >>> 0;
      }
      break;
    }
    case 0x2: {                                                  // SMLALxy
      const product = BigInt(Math.imul(rmHalf, rsHalf));
      const accLo = BigInt(s.r[rn] >>> 0);
      const accHi = BigInt(s.r[rdHi] | 0);                       // signed extension
      const acc = (BigInt.asIntN(64, accHi << 32n)) | accLo;
      const sum64 = BigInt.asIntN(64, acc + product);
      const sumUnsigned = BigInt.asUintN(64, sum64);
      s.r[rn]   = Number(sumUnsigned & 0xFFFFFFFFn) >>> 0;
      s.r[rdHi] = Number((sumUnsigned >> 32n) & 0xFFFFFFFFn) >>> 0;
      break;
    }
    case 0x3: {                                                  // SMULxy
      s.r[rdHi] = Math.imul(rmHalf, rsHalf) >>> 0;
      break;
    }
  }
}

function armSwap(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const B = (instr & 0x00400000) !== 0;
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;
  const rm = instr & 0xF;
  const addr = s.r[rn];
  if (B) {
    const tmp = cpu.bus.read8(addr);
    cpu.bus.write8(addr, s.r[rm] & 0xFF);
    s.r[rd] = tmp >>> 0;
  } else {
    const aligned = cpu.bus.read32(addr & ~3);
    const rot = (addr & 3) << 3;
    const tmp = rot ? ((aligned >>> rot) | (aligned << (32 - rot))) >>> 0 : aligned;
    cpu.bus.write32(addr & ~3, s.r[rm] >>> 0);
    s.r[rd] = tmp >>> 0;
  }
}

function armBlockTransfer(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const P = (instr & 0x01000000) !== 0;
  const U = (instr & 0x00800000) !== 0;
  const Sbit = (instr & 0x00400000) !== 0;
  const W = (instr & 0x00200000) !== 0;
  const L = (instr & 0x00100000) !== 0;
  const rn = (instr >>> 16) & 0xF;
  const list = instr & 0xFFFF;

  let count = 0;
  for (let i = 0; i < 16; i++) if (list & (1 << i)) count++;
  if (count === 0) {
    if (L) { s.r[15] = cpu.bus.read32(s.r[rn] & ~3); cpu.flushPipeline(); }
    else   { cpu.bus.write32(s.r[rn] & ~3, s.r[15]); }
    if (W) s.r[rn] = U ? (s.r[rn] + 0x40) >>> 0 : (s.r[rn] - 0x40) >>> 0;
    return;
  }
  const base = s.r[rn];
  let addr = U ? base : (base - (count << 2)) >>> 0;
  if (U && P) addr = (addr + 4) >>> 0;
  if (!U && !P) addr = (addr + 4) >>> 0;
  const writebackAddr = U ? (base + (count << 2)) >>> 0 : (base - (count << 2)) >>> 0;

  const userBank = Sbit && !(list & 0x8000);
  const savedMode = s.mode();
  if (userBank) s.switchMode(Mode.USR);

  if (L) {
    let pcLoaded = false;
    for (let i = 0; i < 16; i++) {
      if (!(list & (1 << i))) continue;
      const v = cpu.bus.read32(addr & ~3);
      addr = (addr + 4) >>> 0;
      if (i === 15) {
        if (Sbit) {
          const spsr = s.getSpsr();
          s.switchMode(spsr & 0x1F);
          s.cpsr = spsr >>> 0;
        }
        // ARMv5+ LDM-with-PC interworks like BX — bit 0 selects THUMB.
        // ARMv4T just discards the low bit(s). Without the v5 path,
        // a THUMB function epilogue (POP {…, PC}) returns into ARM
        // mode and goes off the rails.
        if (cpu.isArm9 && !Sbit) {
          if (v & 1) { s.cpsr |= FLAG_T;  s.r[15] = v & ~1; }
          else       { s.cpsr &= ~FLAG_T; s.r[15] = v & ~3; }
        } else {
          const thumb = (s.cpsr & FLAG_T) !== 0;
          s.r[15] = thumb ? (v & ~1) : (v & ~3);
        }
        pcLoaded = true;
      } else {
        s.r[i] = v >>> 0;
      }
    }
    if (pcLoaded) cpu.flushPipeline();
  } else {
    let firstStored = false;
    for (let i = 0; i < 16; i++) {
      if (!(list & (1 << i))) continue;
      let v = s.r[i];
      if (i === 15) v = (v + 4) >>> 0;
      if (i === rn && firstStored) v = writebackAddr;
      cpu.bus.write32(addr & ~3, v >>> 0);
      addr = (addr + 4) >>> 0;
      firstStored = true;
    }
  }

  if (userBank) s.switchMode(savedMode);
  if (W) s.r[rn] = writebackAddr;
}
