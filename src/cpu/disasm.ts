// Very small ARM/THUMB disassembler. Only covers the few instruction
// shapes that show up in a typical reset/crt0 prologue — enough that
// the UI dump at an entry point reads as recognizable assembly rather
// than raw hex. We'll expand this as the interpreter grows.

const COND_NAMES = ['EQ','NE','CS','CC','MI','PL','VS','VC','HI','LS','GE','LT','GT','LE','','NV'];

function hex32(n: number): string { return '0x' + (n >>> 0).toString(16).padStart(8, '0'); }
function hex(n: number, w: number): string { return '0x' + (n >>> 0).toString(16).padStart(w, '0'); }

export function disasmArm(insn: number, pc: number): string {
  insn = insn >>> 0;
  const cond = (insn >>> 28) & 0xF;
  const condS = COND_NAMES[cond];

  // Unconditional NV → either v5 BLX or just NV-condition. For now
  // mark it as the v5 BLX(1) immediate form when bits 27..25 = 101.
  if (cond === 0xF) {
    if (((insn >>> 25) & 0b111) === 0b101) {
      // BLX(1) signed offset, H bit in 24.
      let off = insn & 0x00FFFFFF;
      if (off & 0x00800000) off |= 0xFF000000;
      const h = (insn >>> 24) & 1;
      const target = (pc + 8 + (off << 2) + (h << 1)) >>> 0;
      return `BLX   ${hex32(target)}`;
    }
    return `UNDEFINED (NV) ${hex32(insn)}`;
  }

  // B / BL — 101L oooooo oooooooooooooooooooo
  if (((insn >>> 25) & 0b111) === 0b101) {
    const link = (insn >>> 24) & 1;
    let off = insn & 0x00FFFFFF;
    if (off & 0x00800000) off |= 0xFF000000;
    const target = (pc + 8 + (off << 2)) >>> 0;
    return `${link ? 'BL' : 'B'}${condS}   ${hex32(target)}`;
  }

  // BX Rn — 0001 0010 1111 1111 1111 0001 nnnn
  if ((insn & 0x0FFFFFF0) === 0x012FFF10) {
    return `BX${condS}   R${insn & 0xF}`;
  }

  // MOV / MVN immediate-from-data-processing covers most crt0 reg-setups.
  // Data processing: 00 I oooo S nnnn dddd oooooooooooo
  if (((insn >>> 26) & 0b11) === 0b00 && ((insn >>> 25) & 1) === 1) {
    const op = (insn >>> 21) & 0xF;
    const s = (insn >>> 20) & 1;
    const rn = (insn >>> 16) & 0xF;
    const rd = (insn >>> 12) & 0xF;
    const rot = ((insn >>> 8) & 0xF) * 2;
    const imm = insn & 0xFF;
    const value = ((imm >>> rot) | (imm << (32 - rot))) >>> 0;
    const sStr = s ? 'S' : '';
    const valStr = `#${hex32(value)}`;
    switch (op) {
      case 0x0: return `AND${condS}${sStr} R${rd},R${rn},${valStr}`;
      case 0x4: return `ADD${condS}${sStr} R${rd},R${rn},${valStr}`;
      case 0x2: return `SUB${condS}${sStr} R${rd},R${rn},${valStr}`;
      case 0xA: return `CMP${condS}    R${rn},${valStr}`;
      case 0xC: return `ORR${condS}${sStr} R${rd},R${rn},${valStr}`;
      case 0xD: return `MOV${condS}${sStr} R${rd},${valStr}`;
      case 0xE: return `BIC${condS}${sStr} R${rd},R${rn},${valStr}`;
      case 0xF: return `MVN${condS}${sStr} R${rd},${valStr}`;
      default:  return `DP${condS}.imm  op=${op} R${rd},R${rn},${valStr}`;
    }
  }

  // Single-data-transfer immediate (LDR/STR Rd, [Rn, #imm]).
  // 01 I P U B W L nnnn dddd oooooooooooo
  if (((insn >>> 26) & 0b11) === 0b01) {
    const i = (insn >>> 25) & 1;
    const p = (insn >>> 24) & 1;
    const u = (insn >>> 23) & 1;
    const b = (insn >>> 22) & 1;
    const l = (insn >>> 20) & 1;
    const rn = (insn >>> 16) & 0xF;
    const rd = (insn >>> 12) & 0xF;
    if (i === 0) {
      const off = insn & 0xFFF;
      const sign = u ? '+' : '-';
      const op = l ? 'LDR' : 'STR';
      const bs = b ? 'B' : '';
      if (p) return `${op}${condS}${bs} R${rd},[R${rn},#${sign}${hex(off, 1)}]`;
      return `${op}${condS}${bs} R${rd},[R${rn}],#${sign}${hex(off, 1)}`;
    }
  }

  // LDM / STM — 100 P U S W L nnnn rrrrrrrrrrrrrrrr
  if (((insn >>> 25) & 0b111) === 0b100) {
    const l = (insn >>> 20) & 1;
    const rn = (insn >>> 16) & 0xF;
    const w = (insn >>> 21) & 1;
    const regs = insn & 0xFFFF;
    const regList: string[] = [];
    for (let i = 0; i < 16; i++) if (regs & (1 << i)) regList.push('R' + i);
    return `${l ? 'LDM' : 'STM'}${condS}  R${rn}${w ? '!' : ''},{${regList.join(',')}}`;
  }

  return `.word ${hex32(insn)}`;
}
