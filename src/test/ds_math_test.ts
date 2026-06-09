// Spot-check the DsMath implementation against a few cases.
import { DsMath } from '../io/ds_math';

const m = new DsMath();

function write32(addr: number, v: number): void { m.write32(addr, v >>> 0); }
function read32(addr: number): number { return m.read32(addr); }

let fails = 0;
function eq(label: string, got: number | bigint, want: number | bigint): void {
  if (got !== want) { console.log(`FAIL ${label}: got=${got} want=${want}`); fails++; }
  else console.log(`ok   ${label}`);
}

// ---- 32/32 signed: 100 / 3 = 33 rem 1
m.divcnt = 0;        // mode 0
write32(0x04000290, 100);    // numer lo
write32(0x04000294, 0);
write32(0x04000298, 3);      // denom lo
write32(0x0400029C, 0);
m.write16(0x04000280, 0);    // trigger by writing CNT
eq('32/32 quot', read32(0x040002A0), 33);
eq('32/32 rem',  read32(0x040002A8), 1);

// 32/32 signed: -7 / 2 → quot -3, rem -1 (truncating)
write32(0x04000290, -7 >>> 0);
write32(0x04000294, 0xFFFFFFFF);
write32(0x04000298, 2);
write32(0x0400029C, 0);
m.write16(0x04000280, 0);
eq('32/32 -7/2 quot', read32(0x040002A0) | 0, -3);
eq('32/32 -7/2 rem',  read32(0x040002A8) | 0, -1);

// div by zero
write32(0x04000290, 42);
write32(0x04000294, 0);
write32(0x04000298, 0);
write32(0x0400029C, 0);
m.write16(0x04000280, 0);
eq('div0 cntflag', (m.divcnt >> 14) & 1, 1);

// SQRT 32: sqrt(81) = 9
m.sqrtcnt = 0;
write32(0x040002B8, 81);
m.write16(0x040002B0, 0);
eq('sqrt 81', read32(0x040002B4), 9);

// SQRT 32: sqrt(255) = 15 (floor)
write32(0x040002B8, 255);
m.write16(0x040002B0, 0);
eq('sqrt 255', read32(0x040002B4), 15);

// SQRT 64: sqrt(1<<60) = 1<<30 = 1073741824
m.sqrtcnt = 1;
write32(0x040002B8, 0);
write32(0x040002BC, 0x10000000);     // hi nibble at bit 60
m.write16(0x040002B0, 1);
eq('sqrt 2^60', read32(0x040002B4) >>> 0, 1073741824);

if (fails > 0) { console.log(`\n${fails} failures`); process.exit(1); }
console.log('\nall ok');
