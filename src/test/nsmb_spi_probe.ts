// Hook SPI firmware reads in NSMB and trace what ARM7 reads + what PC asked.
// Usage: npx tsx src/test/nsmb_spi_probe.ts [frames]
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const frames = parseInt(process.argv[2] ?? '600', 10);
const rom = readFileSync('public/New Super Mario Bros.nds');
const emu = new Emulator();
emu.loadRom(rom);

// Hook spi.tickFirmware via monkey-patch of writeData.
const spi: any = emu.spi;
const orig = spi.tickFirmware.bind(spi);
const reads: { addr: number; val: number; pc: number; bp: number }[] = [];
const cmdHistogram = new Map<number, number>();
const addrHistogram = new Map<number, number>();
let totalReads = 0;
let totalTransfers = 0;

spi.tickFirmware = function(byte: number): number {
  const r = orig(byte);
  totalTransfers++;
  const bp = spi.bytePos;
  const cmd = spi.fwCmd;
  cmdHistogram.set(cmd, (cmdHistogram.get(cmd) ?? 0) + 1);
  if (cmd === 0x03 && bp > 3) {
    // The address we just read from is fwAddr - 1 (orig already incremented).
    const addr = (spi.fwAddr - 1) & (spi.firmware.length - 1);
    const pc = emu.cpu7.state.r[15] >>> 0;
    if (reads.length < 5000) reads.push({ addr, val: r & 0xFF, pc, bp });
    addrHistogram.set(addr, (addrHistogram.get(addr) ?? 0) + 1);
    totalReads++;
  }
  return r;
};

// Also count SPICNT reads (0x040001C0).
let spicntReads = 0;
const origR8 = emu.bus7.read8.bind(emu.bus7);
emu.bus7.read8 = function(addr: number): number {
  if ((addr & 0xFFFFFFFE) === 0x040001C0) spicntReads++;
  return origR8(addr);
};

// Sample ARM7 PC and ARM9 PC every step? We just sample per frame.
const arm7PcHistogram = new Map<number, number>();
const arm9PcHistogram = new Map<number, number>();
let ipcSync7Writes = 0;
let ipcFifo7Writes = 0;
const origW16 = emu.bus7.write16.bind(emu.bus7);
emu.bus7.write16 = function(addr: number, v: number): void {
  if ((addr & 0xFFFFFFFC) === 0x04000180) ipcSync7Writes++;
  origW16(addr, v);
};
const origW32 = emu.bus7.write32.bind(emu.bus7);
emu.bus7.write32 = function(addr: number, v: number): void {
  if (addr === 0x04000188) ipcFifo7Writes++;
  if ((addr & 0xFFFFFFFC) === 0x04000180) ipcSync7Writes++;
  origW32(addr, v);
};

// Run frames, sample PCs periodically.
let arm9PcSamples = 0;
for (let f = 0; f < frames; f++) {
  // sample PC mid-frame
  for (let s = 0; s < 50; s++) {
    // can't easily sample mid-step from outside; rely on per-frame end snapshot
  }
  emu.runFrame();
  const a7pc = emu.cpu7.state.r[15] >>> 0;
  const a9pc = emu.cpu9.state.r[15] >>> 0;
  arm7PcHistogram.set(a7pc, (arm7PcHistogram.get(a7pc) ?? 0) + 1);
  arm9PcHistogram.set(a9pc, (arm9PcHistogram.get(a9pc) ?? 0) + 1);
  arm9PcSamples++;
}

console.log(`After ${frames} frames:`);
console.log(`  Total SPI byte-transfers: ${totalTransfers}`);
console.log(`  Total firmware-read bytes (cmd 0x03 data phase): ${totalReads}`);
console.log(`  Total SPICNT reads: ${spicntReads}`);
console.log(`  IPCSYNC writes by ARM7: ${ipcSync7Writes}`);
console.log(`  IPCFIFO writes by ARM7: ${ipcFifo7Writes}`);
console.log(`  ARM7 PC final: 0x${emu.cpu7.state.r[15].toString(16)}`);
console.log(`  ARM9 PC final: 0x${emu.cpu9.state.r[15].toString(16)}`);
console.log();
console.log('cmd histogram:');
for (const [c, n] of [...cmdHistogram.entries()].sort((a,b) => b[1]-a[1])) {
  console.log(`  cmd 0x${c.toString(16).padStart(2,'0')}: ${n}`);
}
console.log();
console.log('Top 30 most-read firmware addresses (specific bytes, not bulk):');
const addrs = [...addrHistogram.entries()].sort((a,b) => b[1]-a[1]);
for (const [a, n] of addrs.slice(0, 30)) {
  console.log(`  0x${a.toString(16).padStart(5,'0')}: ${n} reads`);
}
console.log();
console.log('Top 10 ARM7 PCs (per-frame samples):');
for (const [pc, n] of [...arm7PcHistogram.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)) {
  console.log(`  0x${pc.toString(16)}: ${n}`);
}
console.log('Top 10 ARM9 PCs (per-frame samples):');
for (const [pc, n] of [...arm9PcHistogram.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)) {
  console.log(`  0x${pc.toString(16)}: ${n}`);
}

// Show distinct PCs that issued firmware reads.
console.log();
console.log('First 30 firmware reads (addr, val, ARM7 PC, bytePos):');
for (const r of reads.slice(0, 30)) {
  console.log(`  addr=0x${r.addr.toString(16).padStart(5,'0')} val=0x${r.val.toString(16).padStart(2,'0')} pc=0x${r.pc.toString(16)} bp=${r.bp}`);
}

// PCs that read firmware
const pcs = new Map<number, number>();
for (const r of reads) pcs.set(r.pc, (pcs.get(r.pc) ?? 0) + 1);
console.log();
console.log('PCs that issued firmware-read byte exchanges (top 15):');
for (const [pc, n] of [...pcs.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15)) {
  console.log(`  0x${pc.toString(16)}: ${n}`);
}

// Address-range buckets
console.log();
console.log('Address-range buckets:');
const buckets = new Map<string, number>();
for (const [a, n] of addrHistogram) {
  const key =
    a < 0x100        ? 'header 0x000-0x0FF' :
    a < 0x200        ? 'wifi cal hdr 0x100-0x1FF' :
    a < 0x3F800      ? 'flash body' :
    a < 0x3FE00      ? 'wifi cal 0x3F800-0x3FDFF' :
    a < 0x3FF00      ? 'user settings 0 0x3FE00-0x3FEFF' :
    a < 0x40000      ? 'user settings 1 0x3FF00-0x3FFFF' :
    a < 0x7F800      ? 'mirror of body? 0x40000-0x7F7FF' :
    a < 0x7FE00      ? 'wifi cal 0x7F800-0x7FDFF' :
    a < 0x7FF00      ? 'user 0 mirror 0x7FE00-0x7FEFF' :
    a < 0x7FFF8      ? 'user 1 mirror 0x7FF00-0x7FFF7' :
    a <= 0x7FFFF     ? 'MAC region 0x7FFF8-0x7FFFF' :
                       'other';
  buckets.set(key, (buckets.get(key) ?? 0) + n);
}
for (const [k, n] of [...buckets.entries()].sort((a,b)=>b[1]-a[1])) {
  console.log(`  ${k}: ${n}`);
}
