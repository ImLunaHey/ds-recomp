// Minimal BIOS high-level emulation. Catches SWIs in the CPU before
// they enter exception mode, services them directly, and returns. Also
// installs a tiny ARM IRQ-dispatch stub in the BIOS memory region so
// any IRQ taken on the real exception vector lands on a working
// dispatcher (and the user IRQ handler at the conventional address gets
// called).
//
// ARM7 SWIs we handle: 0x04 IntrWait, 0x05 VBlankIntrWait, 0x06 Halt,
// 0x09 Divide, 0x0B CpuSet, 0x0C CpuFastSet.
// ARM9 SWIs we handle: 0x04 IntrWait, 0x05 VBlankIntrWait, 0x06 Halt,
// 0x09 Divide, 0x0B CpuSet, 0x0C CpuFastSet, 0x0D Sqrt.

import type { Cpu } from '../cpu/cpu';
import type { Irq } from '../io/irq';

// ARM7 BIOS sound tables (SWI 0x20/0x21/0x22). Real BIOS stores fixed
// constants; we generate plausible values clean-room. Most games use
// the result for audio frequency calc and don't strictly verify it.
const sineTable = ((): Int16Array => {
  const t = new Int16Array(64);
  for (let i = 0; i < 64; i++) t[i] = Math.round(Math.sin((i / 64) * Math.PI / 2) * 0x7FFF);
  return t;
})();
const pitchTable = ((): Uint16Array => {
  const t = new Uint16Array(768);
  for (let i = 0; i < 768; i++) t[i] = Math.round(Math.pow(2, i / 768) * 0x1000) & 0xFFFF;
  return t;
})();
const volumeTable = ((): Uint8Array => {
  const t = new Uint8Array(128);
  for (let i = 0; i < 128; i++) t[i] = Math.round(Math.pow(i / 127, 2) * 0x7F);
  return t;
})();

export class BiosHle {
  cpu: Cpu;
  irq: Irq;
  // Pending IntrWait mask — set when a SWI puts the CPU in halt waiting
  // for a specific IRQ subset. The runFrame loop watches this and clears
  // halt + acks IF when a matching bit comes up.
  pendingWaitMask = 0;
  pendingWaitDiscardOld = 0;

  constructor(cpu: Cpu, irq: Irq) {
    this.cpu = cpu;
    this.irq = irq;
  }

  // Called from Cpu.softwareInterrupt. Returns true to skip exception
  // entry (we already handled it).
  handleSwi(comment: number): boolean {
    const s = this.cpu.state;
    // SWI immediate is the low byte of the instruction comment field on
    // both ARM (24-bit) and THUMB (8-bit) — we mask to 0xFF for both.
    const swi = (comment & 0xFF) >>> 0;

    // Decompression / utility SWIs that both CPUs implement identically.
    switch (swi) {
      case 0x10: return this.bitUnPack(s.r[0], s.r[1], s.r[2]);
      case 0x11: return this.lz77UnComp(s.r[0], s.r[1], false);
      case 0x12: return this.lz77UnComp(s.r[0], s.r[1], true);
      case 0x13: return this.huffUnComp(s.r[0], s.r[1]);
      case 0x14: return this.rlUnComp(s.r[0], s.r[1], false);
      case 0x15: return this.rlUnComp(s.r[0], s.r[1], true);
    }
    if (this.cpu.isArm9) {
      switch (swi) {
        case 0x04: return this.intrWait(s.r[0], s.r[1]);
        case 0x05: return this.vblankWait();
        case 0x06: return this.halt();
        case 0x07: return this.halt();   // Sleep — treat as halt
        case 0x08: { s.r[0] = 0; return true; }  // SoundBias (stub: ok)
        case 0x09: { divide(s.r[0] | 0, s.r[1] | 0, s); return true; }
        case 0x0A: { s.r[0] = (s.r[0] | 0) % (s.r[1] | 0 || 1) >>> 0; return true; }
        case 0x0B: cpuSet(this.cpu, s.r[0], s.r[1], s.r[2]); return true;
        case 0x0C: cpuFastSet(this.cpu, s.r[0], s.r[1], s.r[2]); return true;
        case 0x0D: { s.r[0] = Math.floor(Math.sqrt(s.r[0] >>> 0)); return true; }
        case 0x0E: return this.getCRC16(s);
        case 0x0F: { s.r[0] = (s.r[0] >>> 0) ? 1 : 0; return true; }  // IsDebugger
        case 0x1F: return true;          // CustomHalt (stub)
      }
    } else {
      switch (swi) {
        case 0x03: return this.waitByLoop(s.r[0]);
        case 0x04: return this.intrWait(s.r[0], s.r[1]);
        case 0x05: return this.vblankWait();
        case 0x06: return this.halt();
        case 0x07: return this.halt();   // Sleep — treat as halt
        case 0x08: { s.r[0] = 0; return true; }  // SoundBias
        case 0x09: { divide(s.r[0] | 0, s.r[1] | 0, s); return true; }
        case 0x0A: { s.r[0] = (s.r[0] | 0) % (s.r[1] | 0 || 1) >>> 0; return true; }
        case 0x0B: cpuSet(this.cpu, s.r[0], s.r[1], s.r[2]); return true;
        case 0x0C: cpuFastSet(this.cpu, s.r[0], s.r[1], s.r[2]); return true;
        case 0x0E: return this.getCRC16(s);
        case 0x1F: return true;          // CustomHalt (stub)
        case 0x20: { s.r[0] = sineTable[(s.r[0] >>> 0) & 0x3F] >>> 0; return true; }
        case 0x21: { s.r[0] = pitchTable[(s.r[0] >>> 0) & 0x2FF] >>> 0; return true; }
        case 0x22: { s.r[0] = volumeTable[(s.r[0] >>> 0) & 0x7F] >>> 0; return true; }
      }
    }
    // Unhandled — pretend it succeeded (return to user). Better than
    // jumping to vector 0x08 which has no backing memory.
    return true;
  }

  // GBA-style IntrWait: r0 = discardOld, r1 = bitmask. If discardOld
  // and IF & mask is already set, skip wait. Otherwise halt; runFrame
  // wakes us when an IF bit in mask gets raised.
  private intrWait(discardOld: number, mask: number): boolean {
    if (discardOld && (this.irq.if_ & mask) !== 0) {
      this.irq.ackIf(this.irq.if_ & mask);
    }
    this.pendingWaitMask = mask >>> 0;
    this.pendingWaitDiscardOld = discardOld & 1;
    // The real BIOS clears CPSR.I (and sets IME=1) before halting so
    // the IRQ it's waiting for can fire. Games SWI us with I=1 expecting
    // that — without this they halt forever even though the IRQ is
    // pending in IF.
    this.cpu.state.cpsr &= ~0x80;
    this.irq.ime = true;
    this.irq.recache();
    this.cpu.state.halted = true;
    return true;
  }

  private vblankWait(): boolean {
    return this.intrWait(1, 1);
  }

  // BIOS GetCRC16 (SWI 0x0E on ARM7). Computes CRC-16 over a buffer.
  // r0 = initial CRC, r1 = data ptr, r2 = byte length. Returns CRC in r0.
  // Polynomial table is the standard NDS BIOS one (0xC0C1 et al. —
  // equivalent to CRC-16/MODBUS, polynomial 0xA001 reflected).
  private getCRC16(s: { r: Uint32Array }): boolean {
    let crc = s.r[0] & 0xFFFF;
    const ptr = s.r[1] >>> 0;
    const len = s.r[2] >>> 0;
    for (let i = 0; i < len; i++) {
      crc ^= this.cpu.bus.read8((ptr + i) >>> 0);
      for (let b = 0; b < 8; b++) {
        crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
      }
    }
    s.r[0] = crc & 0xFFFF;
    return true;
  }

  // BIOS LZ77UnComp (SWI 0x11 = WRAM target / 0x12 = VRAM target). The
  // 1-byte source-data flag distinguishes 8-bit vs 16-bit dest stride.
  // Source: header u32 (low 8 = compression type 1, high 24 = decompressed
  // length), then a stream of: 1 flag byte where each bit (MSB-first)
  // indicates whether the next chunk is a literal byte (0) or a 2-byte
  // backref (1, encoded as length-3 in high nibble + disp-1 in low 12).
  private lz77UnComp(srcAddr: number, dstAddr: number, vramTarget: boolean): boolean {
    const bus = this.cpu.bus;
    const header = bus.read32(srcAddr);
    const size = header >>> 8;
    let src = srcAddr + 4;
    let dst = dstAddr;
    let written = 0;
    const writeByte = (v: number): void => {
      if (vramTarget) {
        const cur = bus.read16(dst & ~1);
        const shift = (dst & 1) * 8;
        const masked = (cur & ~(0xFF << shift)) | ((v & 0xFF) << shift);
        bus.write16(dst & ~1, masked & 0xFFFF);
      } else {
        bus.write8(dst, v & 0xFF);
      }
      dst++; written++;
    };
    while (written < size) {
      const flags = bus.read8(src++);
      for (let bit = 7; bit >= 0 && written < size; bit--) {
        if ((flags >> bit) & 1) {
          const hi = bus.read8(src++);
          const lo = bus.read8(src++);
          const len = ((hi >> 4) & 0xF) + 3;
          const disp = ((hi & 0xF) << 8) | lo;
          for (let i = 0; i < len && written < size; i++) {
            writeByte(bus.read8(dst - disp - 1));
          }
        } else {
          writeByte(bus.read8(src++));
        }
      }
    }
    return true;
  }

  // BIOS RLUnComp (SWI 0x14/0x15). Header same as LZ77. Stream is a flag
  // byte: MSB = 1 → next byte repeated (low 7 bits + 3) times; MSB = 0 →
  // low 7 bits + 1 literal bytes follow.
  private rlUnComp(srcAddr: number, dstAddr: number, vramTarget: boolean): boolean {
    const bus = this.cpu.bus;
    const header = bus.read32(srcAddr);
    const size = header >>> 8;
    let src = srcAddr + 4;
    let dst = dstAddr;
    let written = 0;
    const writeByte = (v: number): void => {
      if (vramTarget) {
        const cur = bus.read16(dst & ~1);
        const shift = (dst & 1) * 8;
        bus.write16(dst & ~1, ((cur & ~(0xFF << shift)) | ((v & 0xFF) << shift)) & 0xFFFF);
      } else {
        bus.write8(dst, v & 0xFF);
      }
      dst++; written++;
    };
    while (written < size) {
      const flag = bus.read8(src++);
      if (flag & 0x80) {
        const data = bus.read8(src++);
        const count = (flag & 0x7F) + 3;
        for (let i = 0; i < count && written < size; i++) writeByte(data);
      } else {
        const count = (flag & 0x7F) + 1;
        for (let i = 0; i < count && written < size; i++) writeByte(bus.read8(src++));
      }
    }
    return true;
  }

  // BIOS HuffUnComp (SWI 0x13). Source layout:
  //   u32 header  (bits 0-3 = symbol bit-width 4 or 8, bits 8-31 = size)
  //   u8  tree size in 16-byte halves, tree nodes follow.
  //   stream of bits, MSB-first within 32-bit words, traversing tree
  // We bail to a slow but correct walking implementation. Few games use
  // 4-bit Huffman, and the 8-bit form is mostly identical.
  private huffUnComp(srcAddr: number, dstAddr: number): boolean {
    const bus = this.cpu.bus;
    const header = bus.read32(srcAddr);
    const symBits = header & 0xF;            // 4 or 8
    const size = header >>> 8;
    const treeSizeBytes = (bus.read8(srcAddr + 4) + 1) * 2;
    const treeStart = srcAddr + 5;
    const streamStart = srcAddr + 4 + treeSizeBytes;
    let dst = dstAddr;
    let written = 0;
    let buf = 0, bufBits = 0;
    let streamPtr = streamStart;
    const fillWord = (): void => {
      buf = bus.read32(streamPtr); streamPtr += 4; bufBits = 32;
    };
    let outShift = 0;
    let outByte = 0;
    const emitNibble = (v: number): void => {
      outByte |= (v & ((1 << symBits) - 1)) << outShift;
      outShift += symBits;
      if (outShift === 8) {
        bus.write8(dst++, outByte & 0xFF);
        outByte = 0; outShift = 0; written++;
      }
    };
    while (written < size) {
      if (bufBits === 0) fillWord();
      let nodeOff = 0;       // offset within tree from treeStart-1 (root word)
      while (true) {
        if (bufBits === 0) fillWord();
        const bit = (buf >>> 31) & 1;
        buf <<= 1; bufBits--;
        const node = bus.read8(treeStart + nodeOff);
        const isLeaf = (node & (bit ? 0x40 : 0x80)) !== 0;
        const childBase = ((nodeOff >> 1) + (node & 0x3F) + 1) * 2;
        nodeOff = childBase + bit;
        if (isLeaf) {
          emitNibble(bus.read8(treeStart + nodeOff));
          break;
        }
      }
    }
    return true;
  }

  // BIOS BitUnPack (SWI 0x10). r0=src ptr, r1=dst ptr, r2=param block ptr.
  // Param block: u16 srcLen, u8 srcWidth, u8 dstWidth, u32 dataOffset+zeroFlag.
  private bitUnPack(srcAddr: number, dstAddr: number, paramAddr: number): boolean {
    const bus = this.cpu.bus;
    const srcLen     = bus.read16(paramAddr);
    const srcWidth   = bus.read8 (paramAddr + 2);
    const dstWidth   = bus.read8 (paramAddr + 3);
    const offsetInfo = bus.read32(paramAddr + 4);
    const dataOffset = offsetInfo & 0x7FFFFFFF;
    const zeroFlag   = (offsetInfo >>> 31) & 1;
    const srcMask = (1 << srcWidth) - 1;
    let dstAcc = 0, dstBits = 0, dstPtr = dstAddr;
    for (let i = 0; i < srcLen; i++) {
      const byte = bus.read8(srcAddr + i);
      for (let b = 0; b < 8; b += srcWidth) {
        let val = (byte >> b) & srcMask;
        if (val !== 0 || zeroFlag) val = (val + dataOffset) & ((1 << dstWidth) - 1);
        dstAcc |= val << dstBits;
        dstBits += dstWidth;
        if (dstBits >= 32) {
          bus.write32(dstPtr, dstAcc >>> 0);
          dstPtr += 4; dstAcc = 0; dstBits = 0;
        }
      }
    }
    if (dstBits > 0) bus.write32(dstPtr, dstAcc >>> 0);
    return true;
  }

  // BIOS WaitByLoop (SWI 0x03). r0 = iteration count. Real BIOS spins
  // (roughly 4 ARM cycles per iteration). We just consume the call —
  // games that use it for sub-frame timing get a sub-frame "instant
  // sleep" instead, which is fine for everything except super-precise
  // hardware probes.
  private waitByLoop(_count: number): boolean {
    void _count;
    return true;
  }

  // BIOS HALT / Sleep — wait for any IRQ. Like IntrWait but doesn't
  // touch IF or filter by mask. Must clear CPSR.I and set IME=1 so the
  // halt-wake path in Cpu.step() can actually unhalt — the SWI entry
  // raised CPSR.I to 1 to mask IRQs, and on real BIOS the return path
  // restores it via SPSR. We bypass the return path and just unmask
  // here. Also reachable from HALTCNT (0x04000301) writes.
  halt(): boolean {
    this.cpu.state.cpsr &= ~0x80;
    this.irq.ime = true;
    this.irq.recache();
    this.cpu.state.halted = true;
    return true;
  }

  // Called by the emulator each frame after PPU advance. If the CPU is
  // halted in an IntrWait and a matching IRQ has fired, clear it from IF
  // and unhalt.
  serviceWait(): void {
    if (!this.cpu.state.halted || this.pendingWaitMask === 0) return;
    const fired = this.irq.if_ & this.pendingWaitMask;
    if (fired !== 0) {
      this.irq.ackIf(fired);
      this.cpu.state.halted = false;
      this.pendingWaitMask = 0;
    }
  }
}

// Convert ARM7 SWI 0x09 / ARM9 SWI 0x09: signed 32-bit divide.
// Returns { quot, rem, absQuot } in R0/R1/R3.
function divide(num: number, den: number, s: { r: Uint32Array }): void {
  if (den === 0) {
    s.r[0] = num < 0 ? 0xFFFFFFFF : 1;
    s.r[1] = num >>> 0;
    s.r[3] = Math.abs(num) >>> 0;
    return;
  }
  const q = (num / den) | 0;
  const r = (num - q * den) | 0;
  s.r[0] = q >>> 0;
  s.r[1] = r >>> 0;
  s.r[3] = Math.abs(q) >>> 0;
}

// SWI 0x0B CpuSet — r0=src, r1=dst, r2=length+mode. Mode bits: 0..20 =
// word count; bit 24 = fixed source (fill); bit 26 = 32-bit (else 16).
function cpuSet(cpu: Cpu, src: number, dst: number, mode: number): void {
  const count = mode & 0x1FFFFF;
  const fixed = (mode & 0x01000000) !== 0;
  const word32 = (mode & 0x04000000) !== 0;
  let s = src >>> 0, d = dst >>> 0;
  if (word32) {
    const step = 4;
    for (let i = 0; i < count; i++) {
      const v = cpu.bus.read32(s & ~3);
      cpu.bus.write32(d & ~3, v);
      if (!fixed) s = (s + step) >>> 0;
      d = (d + step) >>> 0;
    }
  } else {
    const step = 2;
    for (let i = 0; i < count; i++) {
      const v = cpu.bus.read16(s & ~1);
      cpu.bus.write16(d & ~1, v);
      if (!fixed) s = (s + step) >>> 0;
      d = (d + step) >>> 0;
    }
  }
}

// SWI 0x0C CpuFastSet — like CpuSet but 32-bit only, 8-word chunks.
function cpuFastSet(cpu: Cpu, src: number, dst: number, mode: number): void {
  const count = mode & 0x1FFFFF;
  const fixed = (mode & 0x01000000) !== 0;
  let s = src >>> 0, d = dst >>> 0;
  for (let i = 0; i < count; i++) {
    const v = cpu.bus.read32(s & ~3);
    cpu.bus.write32(d & ~3, v);
    if (!fixed) s = (s + 4) >>> 0;
    d = (d + 4) >>> 0;
  }
}
