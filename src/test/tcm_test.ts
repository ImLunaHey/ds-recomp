// Verify DTCM / ITCM behaviors: virtual-size mirroring + load mode.
import { Bus9 } from '../memory/bus9';
import { SharedMemory } from '../memory/shared';

let fails = 0;
function eq(label: string, got: number, want: number): void {
  if ((got >>> 0) !== (want >>> 0)) { console.log(`FAIL ${label}: got=0x${(got >>> 0).toString(16)} want=0x${(want >>> 0).toString(16)}`); fails++; }
  else console.log(`ok   ${label}`);
}

const mem = new SharedMemory();
const bus = new Bus9(mem);

// 1. Plain DTCM read-back: virtual = physical = 16 KB at 0x00800000.
bus.dtcmBase = 0x00800000;
bus.dtcmVirtualSize = 0x4000;
bus.dtcmEnabled = true;
bus.dtcmLoadMode = false;
bus.write32(0x00800000, 0x11223344);
bus.write32(0x00803FFC, 0xAABBCCDD);
eq('DTCM start',     bus.read32(0x00800000), 0x11223344);
eq('DTCM end',       bus.read32(0x00803FFC), 0xAABBCCDD);

// 2. Mirroring: move DTCM to 0x00600000 with virtual size 32 KB
//    (physical still 16 KB) → 0x00604000 mirrors 0x00600000.
bus.dtcmBase = 0x00600000;
bus.dtcmVirtualSize = 0x8000;
eq('DTCM mirror start', bus.read32(0x00604000), 0x11223344);
eq('DTCM mirror end',   bus.read32(0x00607FFC), 0xAABBCCDD);
eq('DTCM original start kept', bus.read32(0x00600000), 0x11223344);

// 3. DTCM-vs-main-RAM priority. DTCM at 0x03000000 with size > shared
//    WRAM. Writes via DTCM, reads return DTCM not WRAM.
//    First seed main RAM mirror at 0x03000000 with a sentinel.
mem.wramcnt = 0;     // all to ARM9
bus.dtcmBase = 0;    // disable so we can write the WRAM directly
bus.dtcmEnabled = false;
bus.write32(0x03000000, 0xDEAD0001);
bus.write32(0x03007FFC, 0xDEAD0002);
bus.dtcmBase = 0x03000000;
bus.dtcmVirtualSize = 0x8000;
bus.dtcmEnabled = true;
bus.write32(0x03000000, 0xCAFEBABE);    // goes to DTCM
eq('DTCM beats WRAM read', bus.read32(0x03000000), 0xCAFEBABE);

// 4. DTCM load mode: reads should bypass DTCM, writes still hit DTCM.
bus.dtcmLoadMode = true;
eq('DTCM load-mode read sees WRAM', bus.read32(0x03000000), 0xDEAD0001);
bus.write32(0x03000004, 0x12345678);   // writes still go to DTCM
bus.dtcmLoadMode = false;
eq('DTCM load-mode write landed in DTCM',
   bus.read32(0x03000004), 0x12345678);

// 5. Disable DTCM → falls through to underlying memory.
bus.dtcmEnabled = false;
eq('DTCM disabled falls through',
   bus.read32(0x03000000), 0xDEAD0001);
eq('DTCM disabled end',
   bus.read32(0x03007FFC), 0xDEAD0002);

// 6. ITCM: virtual 32 KB at 0x00000000.
bus.itcmBase = 0;
bus.itcmVirtualSize = 0x8000;
bus.itcmEnabled = true;
bus.itcmLoadMode = false;
bus.write32(0x00000000, 0x55555555);
bus.write32(0x00007FFC, 0x77777777);
eq('ITCM start', bus.read32(0x00000000), 0x55555555);
eq('ITCM end',   bus.read32(0x00007FFC), 0x77777777);

// 7. ITCM mirror: increase virtual to 64 KB.
bus.itcmVirtualSize = 0x10000;
eq('ITCM mirror start', bus.read32(0x00008000), 0x55555555);
eq('ITCM mirror end',   bus.read32(0x0000FFFC), 0x77777777);

if (fails > 0) { console.log(`\n${fails} failures`); process.exit(1); }
console.log('\nall ok');
