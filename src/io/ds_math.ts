// NDS Math coprocessors (ARM9 only). The hardware has a non-blocking
// divider at 0x04000280..0x040002AF and a non-blocking square-root unit
// at 0x040002B0..0x040002BF. Each computation is triggered by writing
// to any of its operands (or the control word) and finishes a few
// cycles later. We compute synchronously and report busy = 0.

const DIVCNT  = 0x04000280;
const DIV_NUMER = 0x04000290;   // 64-bit
const DIV_DENOM = 0x04000298;   // 64-bit
const DIV_RESULT = 0x040002A0;  // 64-bit (quotient)
const DIVREM_RESULT = 0x040002A8; // 64-bit (remainder)

const SQRTCNT = 0x040002B0;
const SQRT_RESULT = 0x040002B4;  // 32-bit
const SQRT_PARAM  = 0x040002B8;  // 64-bit

export class DsMath {
  // Storage as little-endian byte arrays so byte/half/word access is
  // uniform; that matches how games actually poke the registers.
  divcnt = 0;
  numer  = new Uint8Array(8);
  denom  = new Uint8Array(8);
  result = new Uint8Array(8);
  remain = new Uint8Array(8);

  sqrtcnt = 0;
  sqrtRes = new Uint8Array(4);
  sqrtParam = new Uint8Array(8);

  // ---- Division ----
  private recomputeDiv(): void {
    const mode = this.divcnt & 0x3;
    let n: bigint, d: bigint;
    if (mode === 0) {
      n = BigInt.asIntN(32, BigInt(u32LE(this.numer, 0)));
      d = BigInt.asIntN(32, BigInt(u32LE(this.denom, 0)));
    } else if (mode === 1 || mode === 3) {
      // mode 3 is reserved; on real HW behaves like mode 1 (64/32).
      n = u64LESigned(this.numer);
      d = BigInt.asIntN(32, BigInt(u32LE(this.denom, 0)));
    } else {
      n = u64LESigned(this.numer);
      d = u64LESigned(this.denom);
    }

    // Error bit (DIVCNT bit 14) checks the FULL 64-bit DENOM register,
    // regardless of mode. RockWrestler tests that 32/32 mode with
    // denom_lo=0 but denom_hi!=0 produces div-by-zero result behavior
    // WITHOUT setting the error bit.
    const fullDenom = u64LEUnsigned(this.denom);
    if (fullDenom === 0n) this.divcnt = (this.divcnt | 0x4000) & 0xFFFF;
    else                  this.divcnt = (this.divcnt & ~0x4000) & 0xFFFF;

    let q: bigint, r: bigint;
    const divByZero = d === 0n;       // divide-by-zero result behavior
    if (divByZero) {
      q = n < 0n ? 1n : -1n;
      r = n;
    } else {
      q = bigIntTruncDiv(n, d);
      r = n - q * d;
    }

    // In 32/32 mode div-by-0, real HW writes a buggy high half for the
    // result: the high half is sign-extension of the *numerator*, not
    // of the low quotient. RockWrestler tests this specifically. The
    // remainder follows the normal sign-extension (= numerator anyway).
    if (mode === 0 && divByZero) {
      const numHigh = n < 0n ? 0xFFFFFFFFn : 0n;
      const qLo = BigInt.asUintN(32, q);
      write64LE(this.result, (numHigh << 32n) | qLo);
      write64LE(this.remain,  r);
    } else {
      write64LE(this.result, q);
      write64LE(this.remain,  r);
    }
  }

  // ---- Square root ----
  private recomputeSqrt(): void {
    const is64 = (this.sqrtcnt & 1) !== 0;
    const v = is64
      ? u64LEUnsigned(this.sqrtParam)
      : BigInt(u32LE(this.sqrtParam, 0));
    let res = bigIntSqrt(v);
    if (res > 0xFFFFFFFFn) res = 0xFFFFFFFFn;
    this.sqrtRes[0] =  Number(res & 0xFFn);
    this.sqrtRes[1] = Number((res >> 8n)  & 0xFFn);
    this.sqrtRes[2] = Number((res >> 16n) & 0xFFn);
    this.sqrtRes[3] = Number((res >> 24n) & 0xFFn);
  }

  // ---- IO byte handlers ----
  read8(addr: number): number {
    if (addr === DIVCNT) return this.divcnt & 0xFF;
    if (addr === DIVCNT + 1) return (this.divcnt >>> 8) & 0xFF;
    if (addr >= DIV_NUMER && addr < DIV_NUMER + 8) return this.numer[addr - DIV_NUMER];
    if (addr >= DIV_DENOM && addr < DIV_DENOM + 8) return this.denom[addr - DIV_DENOM];
    if (addr >= DIV_RESULT && addr < DIV_RESULT + 8) return this.result[addr - DIV_RESULT];
    if (addr >= DIVREM_RESULT && addr < DIVREM_RESULT + 8) return this.remain[addr - DIVREM_RESULT];
    if (addr === SQRTCNT) return this.sqrtcnt & 0xFF;
    if (addr === SQRTCNT + 1) return (this.sqrtcnt >>> 8) & 0xFF;
    if (addr >= SQRT_RESULT && addr < SQRT_RESULT + 4) return this.sqrtRes[addr - SQRT_RESULT];
    if (addr >= SQRT_PARAM && addr < SQRT_PARAM + 8) return this.sqrtParam[addr - SQRT_PARAM];
    return 0;
  }
  write8(addr: number, v: number): void {
    v &= 0xFF;
    if (addr === DIVCNT)       { this.divcnt = (this.divcnt & 0xFF00) | v;       this.recomputeDiv(); return; }
    if (addr === DIVCNT + 1)   { this.divcnt = (this.divcnt & 0x00FF) | (v << 8); this.recomputeDiv(); return; }
    if (addr >= DIV_NUMER && addr < DIV_NUMER + 8) { this.numer[addr - DIV_NUMER] = v; this.recomputeDiv(); return; }
    if (addr >= DIV_DENOM && addr < DIV_DENOM + 8) { this.denom[addr - DIV_DENOM] = v; this.recomputeDiv(); return; }
    if (addr === SQRTCNT)      { this.sqrtcnt = (this.sqrtcnt & 0xFF00) | v;       this.recomputeSqrt(); return; }
    if (addr === SQRTCNT + 1)  { this.sqrtcnt = (this.sqrtcnt & 0x00FF) | (v << 8); this.recomputeSqrt(); return; }
    if (addr >= SQRT_PARAM && addr < SQRT_PARAM + 8) { this.sqrtParam[addr - SQRT_PARAM] = v; this.recomputeSqrt(); return; }
    // Writes to DIV_RESULT / DIVREM_RESULT / SQRT_RESULT are no-ops.
  }
  // Wide accessors compose from byte. Slow but correct.
  read16(a: number): number { return this.read8(a) | (this.read8(a + 1) << 8); }
  read32(a: number): number { return ((this.read8(a) | (this.read8(a + 1) << 8) | (this.read8(a + 2) << 16) | (this.read8(a + 3) << 24)) >>> 0); }
  write16(a: number, v: number): void { this.write8(a, v & 0xFF); this.write8(a + 1, (v >>> 8) & 0xFF); }
  write32(a: number, v: number): void { this.write16(a, v & 0xFFFF); this.write16(a + 2, (v >>> 16) & 0xFFFF); }
}

// ---- Helpers ----
function u32LE(b: Uint8Array, off: number): number {
  return ((b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0);
}
function u64LEUnsigned(b: Uint8Array): bigint {
  const lo = BigInt(u32LE(b, 0));
  const hi = BigInt(u32LE(b, 4));
  return (hi << 32n) | lo;
}
function u64LESigned(b: Uint8Array): bigint {
  return BigInt.asIntN(64, u64LEUnsigned(b));
}
function write64LE(b: Uint8Array, v: bigint): void {
  let x = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xFFn);
    x >>= 8n;
  }
}
function bigIntTruncDiv(a: bigint, b: bigint): bigint {
  // BigInt division in JS is truncating toward zero for negative operands
  // already, so a plain a / b is fine.
  return a / b;
}
function bigIntSqrt(n: bigint): bigint {
  if (n < 0n) return 0n;
  if (n < 2n) return n;
  // Newton's method on bigint.
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + n / x) >> 1n; }
  return x;
}
