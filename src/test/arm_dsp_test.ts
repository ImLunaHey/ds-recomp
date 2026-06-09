// Spot-check saturation arithmetic + DSP multiplies.
import { Cpu } from '../cpu/cpu';
import { armExecute } from '../cpu/arm';
import type { ArmBus } from '../cpu/bus';

const stubBus: ArmBus = {
  read8: () => 0, read16: () => 0, read32: () => 0,
  write8: () => {}, write16: () => {}, write32: () => {},
};

let fails = 0;
function eq(label: string, got: number, want: number): void {
  if ((got >>> 0) !== (want >>> 0)) { console.log(`FAIL ${label}: got=0x${(got >>> 0).toString(16)} want=0x${(want >>> 0).toString(16)}`); fails++; }
  else console.log(`ok   ${label}`);
}

function run(insn: number, regs: Record<number, number>): Cpu {
  const cpu = new Cpu(stubBus, true);
  cpu.state.cpsr = 0x1F;            // SYS mode, no flags
  for (const [k, v] of Object.entries(regs)) cpu.state.r[+k] = v >>> 0;
  armExecute(cpu, insn);
  return cpu;
}

// QADD R0, R1, R2  =  E1020051  (Rn=Rm encoding: QADD Rd,Rm,Rn → Rd=Rm+Rn sat)
// Encoding: cond=E bits 27:24=0001 bits 23:21=000 bit20=0 Rn=2 Rd=0 0000 0101 Rm=1
let cpu = run(0xE1020051, { 1: 10, 2: 20 });
eq('QADD pos', cpu.state.r[0], 30);

cpu = run(0xE1020051, { 1: 0x7FFFFFFF, 2: 1 });
eq('QADD saturate +', cpu.state.r[0], 0x7FFFFFFF);
eq('QADD Q flag set', (cpu.state.cpsr & 0x08000000) >>> 0, 0x08000000);

cpu = run(0xE1020051, { 1: 0x80000000, 2: 0xFFFFFFFF });   // -2^31 + -1 → saturate low
eq('QADD saturate -', cpu.state.r[0], 0x80000000);

// QSUB R0, R1, R2  =  E1220051  (op=01)
cpu = run(0xE1220051, { 1: 100, 2: 30 });
eq('QSUB 100-30', cpu.state.r[0], 70);

// QDADD R0, R1, R2 = E1420051  (op=10)
cpu = run(0xE1420051, { 1: 0, 2: 0x40000000 });   // 0 + sat(2 * 2^30) = 0 + 2^31-1 (saturated)
eq('QDADD inner sat', cpu.state.r[0], 0x7FFFFFFF);
eq('QDADD Q flag', (cpu.state.cpsr & 0x08000000) >>> 0, 0x08000000);

// SMULxy R0, R1, R2  with x=0 y=0 (low halves): SMULBB
// encoding: cond E bits 27:24=0001 bits 22:21=11 bit20=0 Rd=0 (bits 19:16) Rn=0 (bits 15:12, SBZ) Rs=2 (bits 11:8) bit7=1 bits6:5=00 bit4=0 Rm=1 = 0xE1600281
// Actually the encoding for SMULBB is: cond 0001 0110 SBZ Rs 1y x 0 Rm = 0xE1600281?
// Let me just compute: bits 27:24=0001, bits 22:21=11, bit 20=0, bits 7:4=1000 (xy=00 → 0b1000) + bit 4=0
// = bits 27:20 = 00010110 = 0x16
// = bits 7:4   = 1000      = 0x8
// SMULBB R0, R1, R2 = cond(E) | 0x16 << 20 | Rd(0)<<16 | Rn(0)<<12 | Rs(2)<<8 | 0x80 | Rm(1)
//                  = 0xE1_60_00_28_1?  No that doesn't fit byte alignment.
// = 0xE | (0x16 << 4) | shift...  let me just hex it.
// nibbles: cond E | (bits 27:24=1) | (bits 23:20=6) | Rd | Rn | Rs<<4 | (1000<<4|opcode bits) | Rm
//        = 0xE1 60 02 81
const smulbb = (0xE << 28) | (0x16 << 20) | (0 << 16) | (0 << 12) | (2 << 8) | 0x80 | 1;
console.log(`SMULBB encoded: 0x${smulbb.toString(16)}`);
cpu = run(smulbb, { 1: 0x00000005, 2: 0x00000003 });
eq('SMULBB 5*3', cpu.state.r[0], 15);

// SMULBB negative: 0xFFFF = -1 (low half), 5 → -1 * 5 = -5
cpu = run(smulbb, { 1: 0x0000FFFF, 2: 0x00000005 });
eq('SMULBB -1*5', cpu.state.r[0], (-5) >>> 0);

// SMULBT: x=0 (Rm low), y=1 (Rs high). Bits 7:4 = 1100 = 0xC.
const smulbt = (0xE << 28) | (0x16 << 20) | (0 << 16) | (0 << 12) | (2 << 8) | 0xC0 | 1;
cpu = run(smulbt, { 1: 0x00000005, 2: 0x00030000 });   // 5 * (Rs high half = 3) = 15
eq('SMULBT 5*3hi', cpu.state.r[0], 15);

if (fails > 0) { console.log(`\n${fails} failures`); process.exit(1); }
console.log('\nall ok');
