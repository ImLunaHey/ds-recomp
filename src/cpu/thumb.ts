import { CpuState, FLAG_T } from './state';
import { immShift, regShift, applyCarry } from './shifter';
import type { Cpu } from './cpu';

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
  s.setC((a >>> 0) >= (b >>> 0));
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

export function thumbExecute(cpu: Cpu, instr: number): void {
  const s = cpu.state;
  const top = instr >>> 13;

  switch (top) {
    case 0b000: {
      const op = (instr >>> 11) & 3;
      if (op === 3) {
        const I = (instr & 0x0400) !== 0;
        const sub = (instr & 0x0200) !== 0;
        const rnRm = (instr >>> 6) & 7;
        const rs = (instr >>> 3) & 7;
        const rd = instr & 7;
        const b = I ? rnRm : s.r[rnRm];
        s.r[rd] = (sub ? subSetFlags(s, s.r[rs], b) : addSetFlags(s, s.r[rs], b)) >>> 0;
        return;
      }
      const offset = (instr >>> 6) & 0x1F;
      const rs = (instr >>> 3) & 7;
      const rd = instr & 7;
      const r = immShift(op, offset, s.r[rs], s.c());
      s.r[rd] = r.value >>> 0;
      s.setNZ(r.value);
      applyCarry(s, r.carry);
      return;
    }
    case 0b001: {
      const op = (instr >>> 11) & 3;
      const rd = (instr >>> 8) & 7;
      const imm = instr & 0xFF;
      switch (op) {
        case 0: s.r[rd] = imm; s.setNZ(imm); return;
        case 1: subSetFlags(s, s.r[rd], imm); return;
        case 2: s.r[rd] = addSetFlags(s, s.r[rd], imm); return;
        case 3: s.r[rd] = subSetFlags(s, s.r[rd], imm); return;
      }
      return;
    }
    case 0b010: {
      const high4 = instr >>> 12;
      if (high4 === 0b0101) {
        const bit9 = (instr >>> 9) & 1;
        const ro = (instr >>> 6) & 7;
        const rb = (instr >>> 3) & 7;
        const rd = instr & 7;
        const addr = (s.r[rb] + s.r[ro]) >>> 0;
        if (bit9 === 0) {
          const L = (instr & 0x0800) !== 0;
          const B = (instr & 0x0400) !== 0;
          if (L) {
            if (B) s.r[rd] = cpu.bus.read8(addr) >>> 0;
            else {
              const aligned = cpu.bus.read32(addr & ~3);
              const rot = (addr & 3) << 3;
              s.r[rd] = (rot ? ((aligned >>> rot) | (aligned << (32 - rot))) : aligned) >>> 0;
            }
          } else {
            if (B) cpu.bus.write8(addr, s.r[rd] & 0xFF);
            else   cpu.bus.write32(addr & ~3, s.r[rd] >>> 0);
          }
        } else {
          const H = (instr & 0x0800) !== 0;
          const S = (instr & 0x0400) !== 0;
          if (!H && !S) {
            cpu.bus.write16(addr & ~1, s.r[rd] & 0xFFFF);
          } else if (!H && S) {
            const b = cpu.bus.read8(addr);
            s.r[rd] = (b & 0x80) ? (b | 0xFFFFFF00) >>> 0 : b;
          } else if (H && !S) {
            const aligned = cpu.bus.read16(addr & ~1);
            s.r[rd] = ((addr & 1) ? ((aligned >>> 8) | (aligned << 24)) : aligned) >>> 0;
          } else {
            if (addr & 1) {
              const b = cpu.bus.read8(addr);
              s.r[rd] = (b & 0x80) ? (b | 0xFFFFFF00) >>> 0 : b;
            } else {
              const h = cpu.bus.read16(addr);
              s.r[rd] = (h & 0x8000) ? (h | 0xFFFF0000) >>> 0 : h;
            }
          }
        }
        return;
      }
      if (((instr >>> 10) & 7) === 0b000) {
        const op = (instr >>> 6) & 0xF;
        const rs = (instr >>> 3) & 7;
        const rd = instr & 7;
        const a = s.r[rd];
        const b = s.r[rs];
        const cIn = s.c();
        switch (op) {
          case 0x0: { const v = (a & b) >>> 0; s.r[rd] = v; s.setNZ(v); return; }
          case 0x1: { const v = (a ^ b) >>> 0; s.r[rd] = v; s.setNZ(v); return; }
          case 0x2: { const r = regShift(0, b & 0xFF, a, cIn); s.r[rd] = r.value >>> 0; s.setNZ(r.value); applyCarry(s, r.carry); return; }
          case 0x3: { const r = regShift(1, b & 0xFF, a, cIn); s.r[rd] = r.value >>> 0; s.setNZ(r.value); applyCarry(s, r.carry); return; }
          case 0x4: { const r = regShift(2, b & 0xFF, a, cIn); s.r[rd] = r.value >>> 0; s.setNZ(r.value); applyCarry(s, r.carry); return; }
          case 0x5: s.r[rd] = adcSetFlags(s, a, b, cIn); return;
          case 0x6: s.r[rd] = sbcSetFlags(s, a, b, cIn); return;
          case 0x7: { const r = regShift(3, b & 0xFF, a, cIn); s.r[rd] = r.value >>> 0; s.setNZ(r.value); applyCarry(s, r.carry); return; }
          case 0x8: { const v = (a & b) >>> 0; s.setNZ(v); return; }
          case 0x9: s.r[rd] = subSetFlags(s, 0, b); return;
          case 0xA: subSetFlags(s, a, b); return;
          case 0xB: addSetFlags(s, a, b); return;
          case 0xC: { const v = (a | b) >>> 0; s.r[rd] = v; s.setNZ(v); return; }
          case 0xD: { const v = Math.imul(a, b) >>> 0; s.r[rd] = v; s.setNZ(v); return; }
          case 0xE: { const v = (a & ~b) >>> 0; s.r[rd] = v; s.setNZ(v); return; }
          case 0xF: { const v = (~b) >>> 0; s.r[rd] = v; s.setNZ(v); return; }
        }
        return;
      }
      if (((instr >>> 10) & 7) === 0b001) {
        const op = (instr >>> 8) & 3;
        const H1 = (instr & 0x80) !== 0;
        const H2 = (instr & 0x40) !== 0;
        const rs = ((instr >>> 3) & 7) | (H2 ? 8 : 0);
        const rd = (instr & 7) | (H1 ? 8 : 0);
        let a = s.r[rd];
        let b = s.r[rs];
        if (rd === 15) a = (a & ~1) >>> 0;
        if (rs === 15) b = (b & ~1) >>> 0;
        switch (op) {
          case 0: {
            const v = (a + b) >>> 0;
            if (rd === 15) { s.r[15] = v & ~1; cpu.flushPipeline(); }
            else s.r[rd] = v;
            return;
          }
          case 1: subSetFlags(s, a, b); return;
          case 2: {
            if (rd === 15) { s.r[15] = b & ~1; cpu.flushPipeline(); }
            else s.r[rd] = b >>> 0;
            return;
          }
          case 3: {
            // BX (H1 == 0) or BLX (H1 == 1, ARMv5 only).
            if (cpu.isArm9 && H1) {
              s.r[14] = ((s.r[15] - 2) | 1) >>> 0;
            }
            if (b & 1) { s.cpsr |= FLAG_T; s.r[15] = b & ~1; }
            else        { s.cpsr &= ~FLAG_T; s.r[15] = b & ~3; }
            cpu.flushPipeline();
            return;
          }
        }
        return;
      }
      const rd = (instr >>> 8) & 7;
      const imm = (instr & 0xFF) << 2;
      const addr = ((s.r[15] & ~3) + imm) >>> 0;
      s.r[rd] = cpu.bus.read32(addr) >>> 0;
      return;
    }
    case 0b011: {
      const B = (instr & 0x1000) !== 0;
      const L = (instr & 0x0800) !== 0;
      const imm = (instr >>> 6) & 0x1F;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const addr = B ? (s.r[rb] + imm) >>> 0 : (s.r[rb] + (imm << 2)) >>> 0;
      if (L) {
        if (B) s.r[rd] = cpu.bus.read8(addr) >>> 0;
        else {
          const aligned = cpu.bus.read32(addr & ~3);
          const rot = (addr & 3) << 3;
          s.r[rd] = (rot ? ((aligned >>> rot) | (aligned << (32 - rot))) : aligned) >>> 0;
        }
      } else {
        if (B) cpu.bus.write8(addr, s.r[rd] & 0xFF);
        else   cpu.bus.write32(addr & ~3, s.r[rd] >>> 0);
      }
      return;
    }
    case 0b100: {
      if ((instr & 0x1000) === 0) {
        const L = (instr & 0x0800) !== 0;
        const imm = ((instr >>> 6) & 0x1F) << 1;
        const rb = (instr >>> 3) & 7;
        const rd = instr & 7;
        const addr = (s.r[rb] + imm) >>> 0;
        if (L) {
          const aligned = cpu.bus.read16(addr & ~1);
          s.r[rd] = ((addr & 1) ? ((aligned >>> 8) | (aligned << 24)) : aligned) >>> 0;
        } else {
          cpu.bus.write16(addr & ~1, s.r[rd] & 0xFFFF);
        }
        return;
      }
      const L = (instr & 0x0800) !== 0;
      const rd = (instr >>> 8) & 7;
      const imm = (instr & 0xFF) << 2;
      const addr = (s.r[13] + imm) >>> 0;
      if (L) {
        const aligned = cpu.bus.read32(addr & ~3);
        const rot = (addr & 3) << 3;
        s.r[rd] = (rot ? ((aligned >>> rot) | (aligned << (32 - rot))) : aligned) >>> 0;
      } else {
        cpu.bus.write32(addr & ~3, s.r[rd] >>> 0);
      }
      return;
    }
    case 0b101: {
      if ((instr & 0x1000) === 0) {
        const SP = (instr & 0x0800) !== 0;
        const rd = (instr >>> 8) & 7;
        const imm = (instr & 0xFF) << 2;
        if (SP) s.r[rd] = (s.r[13] + imm) >>> 0;
        else    s.r[rd] = ((s.r[15] & ~3) + imm) >>> 0;
        return;
      }
      if ((instr & 0x0F00) === 0x0000) {
        const imm = (instr & 0x7F) << 2;
        s.r[13] = ((instr & 0x80) ? (s.r[13] - imm) : (s.r[13] + imm)) >>> 0;
        return;
      }
      if ((instr & 0x0600) === 0x0400) {
        const L = (instr & 0x0800) !== 0;
        const R = (instr & 0x0100) !== 0;
        const list = instr & 0xFF;
        if (L) {
          let sp = s.r[13];
          for (let i = 0; i < 8; i++) {
            if (list & (1 << i)) { s.r[i] = cpu.bus.read32(sp & ~3) >>> 0; sp = (sp + 4) >>> 0; }
          }
          if (R) {
            const v = cpu.bus.read32(sp & ~3) >>> 0;
            sp = (sp + 4) >>> 0;
            // ARMv5: POP {PC} interworks via bit 0. ARMv4T does not.
            if (cpu.isArm9 && (v & 1)) {
              s.cpsr |= FLAG_T;
              s.r[15] = v & ~1;
            } else if (cpu.isArm9) {
              s.cpsr &= ~FLAG_T;
              s.r[15] = v & ~3;
            } else {
              s.r[15] = v & ~1;
            }
            cpu.flushPipeline();
          }
          s.r[13] = sp;
        } else {
          let count = 0;
          for (let i = 0; i < 8; i++) if (list & (1 << i)) count++;
          if (R) count++;
          const start = (s.r[13] - (count << 2)) >>> 0;
          let sp = start;
          for (let i = 0; i < 8; i++) {
            if (list & (1 << i)) { cpu.bus.write32(sp & ~3, s.r[i] >>> 0); sp = (sp + 4) >>> 0; }
          }
          if (R) { cpu.bus.write32(sp & ~3, s.r[14] >>> 0); }
          s.r[13] = start;
        }
        return;
      }
      return;
    }
    case 0b110: {
      if ((instr & 0x1000) === 0) {
        const L = (instr & 0x0800) !== 0;
        const rb = (instr >>> 8) & 7;
        const list = instr & 0xFF;
        let addr = s.r[rb];
        if (list === 0) {
          if (L) { s.r[15] = cpu.bus.read32(addr & ~3); cpu.flushPipeline(); }
          else   { cpu.bus.write32(addr & ~3, s.r[15]); }
          s.r[rb] = (addr + 0x40) >>> 0;
          return;
        }
        const baseInList = (list & (1 << rb)) !== 0;
        const baseFirst = baseInList && (list & ((1 << rb) - 1)) === 0;
        const startAddr = addr;
        for (let i = 0; i < 8; i++) {
          if (!(list & (1 << i))) continue;
          if (L) {
            s.r[i] = cpu.bus.read32(addr & ~3) >>> 0;
          } else {
            if (i === rb && !baseFirst) {
              let count = 0;
              for (let j = 0; j < 8; j++) if (list & (1 << j)) count++;
              cpu.bus.write32(addr & ~3, (startAddr + (count << 2)) >>> 0);
            } else {
              cpu.bus.write32(addr & ~3, s.r[i] >>> 0);
            }
          }
          addr = (addr + 4) >>> 0;
        }
        if (!L || !baseInList) s.r[rb] = addr;
        return;
      }
      const cond = (instr >>> 8) & 0xF;
      if (cond === 0xF) {
        cpu.softwareInterrupt(instr & 0xFF);
        return;
      }
      if (cond === 0xE) return;
      if (!s.checkCond(cond)) return;
      let off = (instr & 0xFF) << 1;
      if (off & 0x100) off |= 0xFFFFFE00;
      s.r[15] = (s.r[15] + off) >>> 0;
      cpu.flushPipeline();
      return;
    }
    case 0b111: {
      if ((instr & 0x1800) === 0x0000) {
        let off = (instr & 0x07FF) << 1;
        if (off & 0x0800) off |= 0xFFFFF000;
        s.r[15] = (s.r[15] + off) >>> 0;
        cpu.flushPipeline();
        return;
      }
      // ARMv5: H == 01 is BLX low half — switches to ARM mode.
      const H = (instr >>> 11) & 3;
      if (H === 0b10) {
        let off = (instr & 0x7FF) << 12;
        if (off & 0x00400000) off |= 0xFF800000;
        s.r[14] = (s.r[15] + off) >>> 0;
        return;
      }
      if (H === 0b11) {
        const newPc = (s.r[14] + ((instr & 0x7FF) << 1)) >>> 0;
        const newLr = ((s.r[15] - 2) | 1) >>> 0;
        s.r[15] = newPc & ~1;
        s.r[14] = newLr;
        cpu.flushPipeline();
        return;
      }
      if (H === 0b01 && cpu.isArm9) {
        // BLX immediate (THUMB→ARM). Like BL low half but switches T off
        // and aligns to a word.
        const newPc = ((s.r[14] + ((instr & 0x7FF) << 1)) >>> 0) & ~3;
        const newLr = ((s.r[15] - 2) | 1) >>> 0;
        s.cpsr &= ~FLAG_T;
        s.r[15] = newPc;
        s.r[14] = newLr;
        cpu.flushPipeline();
        return;
      }
      return;
    }
  }
}
