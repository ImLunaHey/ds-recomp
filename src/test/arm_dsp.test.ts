import { describe, it, expect } from 'vitest';
import { Cpu } from '../cpu/cpu';
import { armExecute } from '../cpu/arm';
import type { ArmBus } from '../cpu/bus';

const stubBus: ArmBus = {
  read8: () => 0, read16: () => 0, read32: () => 0,
  write8: () => {}, write16: () => {}, write32: () => {},
};

function run(insn: number, regs: Record<number, number>): Cpu {
  const cpu = new Cpu(stubBus, true);
  cpu.state.cpsr = 0x1F;
  for (const [k, v] of Object.entries(regs)) cpu.state.r[+k] = v >>> 0;
  armExecute(cpu, insn);
  return cpu;
}

// QADD Rd=0, Rm=1 (low nibble), Rn=2 (bits 19:16).
//   cond=E bits 27:24=0001 op22:21=00 bit20=0 Rn=2 Rd=0 bits 11:8=0 bits 7:4=0101 Rm=1
const QADD = 0xE1020051;
const QSUB = 0xE1220051;
const QDADD = 0xE1420051;
const FLAG_Q = 0x08000000;

describe('ARMv5 saturation arithmetic', () => {
  it('QADD straight signed sum', () => {
    const cpu = run(QADD, { 1: 10, 2: 20 });
    expect(cpu.state.r[0]).toBe(30);
  });
  it('QADD saturates positive overflow and sets Q', () => {
    const cpu = run(QADD, { 1: 0x7FFFFFFF, 2: 1 });
    expect(cpu.state.r[0] >>> 0).toBe(0x7FFFFFFF);
    expect((cpu.state.cpsr & FLAG_Q) >>> 0).toBe(FLAG_Q >>> 0);
  });
  it('QADD saturates negative overflow', () => {
    const cpu = run(QADD, { 1: 0x80000000, 2: 0xFFFFFFFF });
    expect(cpu.state.r[0] >>> 0).toBe(0x80000000);
  });
  it('QSUB 100 - 30 = 70', () => {
    const cpu = run(QSUB, { 1: 100, 2: 30 });
    expect(cpu.state.r[0]).toBe(70);
  });
  it('QDADD inner saturation sets Q', () => {
    // 0 + sat(2 * 2^30) → sat(2^31) = 2^31-1, Q set
    const cpu = run(QDADD, { 1: 0, 2: 0x40000000 });
    expect(cpu.state.r[0] >>> 0).toBe(0x7FFFFFFF);
    expect((cpu.state.cpsr & FLAG_Q) >>> 0).toBe(FLAG_Q >>> 0);
  });
});

// SMULBB / SMULBT encoding: cond bits 27:20=00010110 Rd=Rn=0 Rs|0x80|Rm
function smulxy(rd: number, rm: number, rs: number, x: 0 | 1, y: 0 | 1): number {
  return (0xE << 28) | (0x16 << 20) | (rd << 16) | (0 << 12) | (rs << 8) |
         (0x80 | (y << 6) | (x << 5)) | rm;
}

describe('ARMv5 DSP halfword multiplies', () => {
  it('SMULBB: 5 * 3 = 15', () => {
    const cpu = run(smulxy(0, 1, 2, 0, 0), { 1: 5, 2: 3 });
    expect(cpu.state.r[0]).toBe(15);
  });
  it('SMULBB: -1 (low half) * 5 = -5', () => {
    const cpu = run(smulxy(0, 1, 2, 0, 0), { 1: 0x0000FFFF, 2: 5 });
    expect(cpu.state.r[0] | 0).toBe(-5);
  });
  it('SMULBT: low-of-Rm × high-of-Rs', () => {
    const cpu = run(smulxy(0, 1, 2, 0, 1), { 1: 5, 2: 0x00030000 });
    expect(cpu.state.r[0]).toBe(15);
  });
  it('SMULTT: high × high', () => {
    const cpu = run(smulxy(0, 1, 2, 1, 1), { 1: 0x00070000, 2: 0x00040000 });
    expect(cpu.state.r[0]).toBe(28);
  });
});
