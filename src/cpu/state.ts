// ARM register file shared between ARM9 (ARMv5TE) and ARM7 (ARMv4T).
// Both cores have the same banked register layout — only the
// instruction set + cache/CP15 differ. We keep the bank logic and
// condition-code helpers identical to gba-recomp.

export const enum Mode {
  USR = 0x10,
  FIQ = 0x11,
  IRQ = 0x12,
  SVC = 0x13,
  ABT = 0x17,
  UND = 0x1B,
  SYS = 0x1F,
}

export const FLAG_N = 0x80000000 | 0;
export const FLAG_Z = 0x40000000 | 0;
export const FLAG_C = 0x20000000 | 0;
export const FLAG_V = 0x10000000 | 0;
export const FLAG_I = 0x80;
export const FLAG_F = 0x40;
export const FLAG_T = 0x20;

const BANK_USR = 0;
const BANK_FIQ = 1;
const BANK_IRQ = 2;
const BANK_SVC = 3;
const BANK_ABT = 4;
const BANK_UND = 5;

function modeBank(mode: number): number {
  switch (mode) {
    case Mode.FIQ: return BANK_FIQ;
    case Mode.IRQ: return BANK_IRQ;
    case Mode.SVC: return BANK_SVC;
    case Mode.ABT: return BANK_ABT;
    case Mode.UND: return BANK_UND;
    default:       return BANK_USR;
  }
}

export class CpuState {
  r = new Uint32Array(16);
  bank_r13 = new Uint32Array(6);
  bank_r14 = new Uint32Array(6);
  bank_spsr = new Uint32Array(6);
  fiq_r8_12 = new Uint32Array(5);
  usr_r8_12 = new Uint32Array(5);
  usr_r13 = 0;
  usr_r14 = 0;
  cpsr = 0;
  halted = false;

  constructor() {
    this.cpsr = Mode.SVC | FLAG_I | FLAG_F;
  }

  mode(): number { return this.cpsr & 0x1F; }
  inThumb(): boolean { return (this.cpsr & FLAG_T) !== 0; }
  irqDisabled(): boolean { return (this.cpsr & FLAG_I) !== 0; }

  setNZ(value: number): void {
    let cpsr = this.cpsr;
    cpsr &= ~(FLAG_N | FLAG_Z);
    if ((value | 0) < 0) cpsr |= FLAG_N;
    if ((value & 0xFFFFFFFF) === 0) cpsr |= FLAG_Z;
    this.cpsr = cpsr;
  }
  setNZ64Hi(hi: number, lo: number): void {
    let cpsr = this.cpsr;
    cpsr &= ~(FLAG_N | FLAG_Z);
    if ((hi | 0) < 0) cpsr |= FLAG_N;
    if (hi === 0 && lo === 0) cpsr |= FLAG_Z;
    this.cpsr = cpsr;
  }
  setC(c: boolean): void { if (c) this.cpsr |= FLAG_C; else this.cpsr &= ~FLAG_C; }
  setV(v: boolean): void { if (v) this.cpsr |= FLAG_V; else this.cpsr &= ~FLAG_V; }
  c(): number { return (this.cpsr >>> 29) & 1; }

  checkCond(cond: number): boolean {
    const cpsr = this.cpsr;
    const n = (cpsr & FLAG_N) !== 0;
    const z = (cpsr & FLAG_Z) !== 0;
    const c = (cpsr & FLAG_C) !== 0;
    const v = (cpsr & FLAG_V) !== 0;
    switch (cond) {
      case 0x0: return z;
      case 0x1: return !z;
      case 0x2: return c;
      case 0x3: return !c;
      case 0x4: return n;
      case 0x5: return !n;
      case 0x6: return v;
      case 0x7: return !v;
      case 0x8: return c && !z;
      case 0x9: return !c || z;
      case 0xA: return n === v;
      case 0xB: return n !== v;
      case 0xC: return !z && n === v;
      case 0xD: return z || n !== v;
      case 0xE: return true;
      default:  return false;
    }
  }

  switchMode(newMode: number): void {
    const oldMode = this.mode();
    if (oldMode === newMode) return;
    const oldBank = modeBank(oldMode);
    const newBank = modeBank(newMode);
    if (oldBank === BANK_USR) {
      this.usr_r13 = this.r[13];
      this.usr_r14 = this.r[14];
    } else {
      this.bank_r13[oldBank] = this.r[13];
      this.bank_r14[oldBank] = this.r[14];
    }
    if (oldBank === BANK_FIQ) {
      for (let i = 0; i < 5; i++) this.fiq_r8_12[i] = this.r[8 + i];
    } else {
      for (let i = 0; i < 5; i++) this.usr_r8_12[i] = this.r[8 + i];
    }
    if (newBank === BANK_USR) {
      this.r[13] = this.usr_r13;
      this.r[14] = this.usr_r14;
    } else {
      this.r[13] = this.bank_r13[newBank];
      this.r[14] = this.bank_r14[newBank];
    }
    if (newBank === BANK_FIQ) {
      for (let i = 0; i < 5; i++) this.r[8 + i] = this.fiq_r8_12[i];
    } else {
      for (let i = 0; i < 5; i++) this.r[8 + i] = this.usr_r8_12[i];
    }
    this.cpsr = (this.cpsr & ~0x1F) | (newMode & 0x1F);
  }

  getSpsr(): number {
    const b = modeBank(this.mode());
    if (b === BANK_USR) return this.cpsr;
    return this.bank_spsr[b];
  }
  setSpsr(v: number): void {
    const b = modeBank(this.mode());
    if (b === BANK_USR) return;
    this.bank_spsr[b] = v >>> 0;
  }

  enterException(targetMode: number, vector: number, savedPc: number, setF: boolean): void {
    const oldCpsr = this.cpsr;
    const targetBank = modeBank(targetMode);
    this.switchMode(targetMode);
    this.r[14] = savedPc >>> 0;
    this.bank_spsr[targetBank] = oldCpsr >>> 0;
    this.cpsr = (this.cpsr & ~FLAG_T) | FLAG_I;
    if (setF) this.cpsr |= FLAG_F;
    this.r[15] = vector >>> 0;
  }
}
