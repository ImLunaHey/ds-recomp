// Minimal IO port router. Both CPUs see IO at 0x04000000+. Per-CPU IO
// state (IE/IF, KEYINPUT) lives on this IoBus; shared state (PPU,
// IPC) is passed in by reference.
//
// Each handler is at byte granularity. Half-word and word reads/writes
// are decomposed into byte ops at the top of read16/read32 — slow but
// uniform. We can optimize hot ports later by overriding the wider
// methods.

import { Irq } from './irq';
import type { Ppu } from '../ppu/ppu';
// Affine BG IO helper (BG2/BG3 PA..PD + refX/refY) — see writeAffineByte().
import type { SharedMemory } from '../memory/shared';
import type { Ipc } from './ipc';
import type { Cart } from '../cart/cart';
import type { Dma } from './dma';
import type { DsMath } from './ds_math';
import type { Spi } from './spi';
import type { BiosHle } from '../bios/hle';
import type { Timers } from './timers';
import { Rtc } from './rtc';
import { Sound } from './sound';

export class IoBus {
  irq: Irq;
  ppu: Ppu;
  mem: SharedMemory;
  ipc: Ipc;
  cart: Cart;
  dma: Dma;
  math: DsMath | null;     // ARM9 only — null on the ARM7 side
  spi: Spi | null;         // ARM7 only — null on the ARM9 side
  // RTC is ARM7-side; ARM9 access is masked off in real hardware.
  rtc: Rtc = new Rtc();
  // Sound chip is ARM7-only; ARM9 sees these addresses as the 3D
  // engine's GXFIFO/direct command ports. The IoBus check below
  // gates routing on isArm9 to keep them separate.
  sound: Sound = new Sound();
  bios: BiosHle | null = null;  // attached after Cpu construction
  timers: Timers | null = null; // wired in Emulator
  isArm9: boolean;
  // POSTFLG (0x04000300) bit 0 = "boot completed". Per GBATEK: "Games
  // require it set to function." Real BIOS sets it before jumping to
  // game code. We HLE the boot handoff so initialize it to 1.
  postflg = 1;
  // POWCNT1 (ARM9 only, 0x04000304). Bit 15 = NDS Display Swap
  // (0 = Engine A → bottom screen, 1 = Engine A → top screen). Brain
  // Training (and a few other games) write 0 here to put the
  // touch-driven content on the bottom physical screen while leaving
  // the always-visible HUD on top via Engine B. The PPU's frame
  // composer renders to fbA/fbB based on engine; the UI then picks
  // which one to show on which canvas using the displaySwap flag.
  powcnt1 = 0x820F;          // typical post-BIOS default per GBATEK
  // HALTCNT — write 0x80 puts the CPU into halt.
  haltcnt = 0;
  // Latch for partial (8/16-bit) writes into 32-bit-only GX ports
  // (0x04000400 and 0x04000440..0x040005FF). Keyed by word-aligned addr;
  // mask tracks which bytes have arrived. Word fires when mask == 0xF.
  gxLatch = new Map<number, number>();
  gxLatchMask = new Map<number, number>();
  // Captured KEYINPUT — bits LOW = pressed. Default all up = 0x3FF.
  keyinput = 0x03FF;
  extKeyinput = 0x007F;   // X, Y, lid open (low = active)

  constructor(irq: Irq, ppu: Ppu, mem: SharedMemory, ipc: Ipc, cart: Cart, dma: Dma, math: DsMath | null, spi: Spi | null, isArm9: boolean) {
    this.irq = irq;
    this.ppu = ppu;
    this.mem = mem;
    this.ipc = ipc;
    this.cart = cart;
    this.dma = dma;
    this.math = math;
    this.spi = spi;
    this.isArm9 = isArm9;
    // ARM9-side IO owns cart-DMA-ready trigger + cart-end IRQ. Only
    // ARM9 has the cart-ready DMA timing (= 5), and EXMEMCNT defaults
    // route cart to ARM9. Don't double-register from ARM7's IO; the
    // ARM7 instance constructs second and its registration would
    // overwrite the ARM9 one.
    if (isArm9) {
      cart.onTransferReady = () => dma.triggerCardReady();
      cart.onTransferEnd = () => {
        // IRQ bit 19 = cart transfer end. Per GBATEK §"Interrupt
        // Control", raised when ROMDATA's last word has been read AND
        // AUXSPICNT bit 14 (transfer-end-IRQ-enable) is set; cart.ts
        // already gates on that bit.
        irq.raise(1 << 19);
      };
    }
  }

  private isDmaAddr(addr: number): boolean {
    const lo = addr & 0xFF;
    return ((addr & 0x0FFFFF00) === 0x04000000) && lo >= 0xB0 && lo < 0xE0;
  }

  private isMathAddr(addr: number): boolean {
    // 0x04000280..0x040002BF
    const masked = addr & 0x0FFFFFFF;
    return masked >= 0x04000280 && masked < 0x040002C0;
  }

  // Is this a GX port (FIFO at 0x04000400 or direct cmd at 0x440..0x5FF)?
  private isGxAddr(addr: number): boolean {
    const masked = addr & 0x0FFFFFFF;
    if (masked === 0x04000400) return true;
    return masked >= 0x04000440 && masked < 0x04000600;
  }

  // Accumulate partial bytes for a 32-bit-only GX port. width is 1 or 2
  // (byte or half-word). When all 4 bytes of a word have arrived, fire
  // writeFifo / writeDirect with the assembled u32.
  private gxPartialWrite(addr: number, value: number, width: 1 | 2): void {
    const wordAddr = addr & ~0x3;
    const off = addr & 0x3;
    const shift = off * 8;
    const fieldMask = width === 1 ? (0xFF << shift) : (0xFFFF << shift);
    const fieldVal = width === 1 ? ((value & 0xFF) << shift) : ((value & 0xFFFF) << shift);
    const cur = this.gxLatch.get(wordAddr) ?? 0;
    const next = ((cur & ~fieldMask) | fieldVal) >>> 0;
    const byteBits = width === 1 ? (1 << off) : (0x3 << off);
    const mask = (this.gxLatchMask.get(wordAddr) ?? 0) | byteBits;
    this.gxLatch.set(wordAddr, next);
    this.gxLatchMask.set(wordAddr, mask);
    if (mask === 0xF) {
      this.gxLatch.delete(wordAddr);
      this.gxLatchMask.delete(wordAddr);
      const maskedWord = wordAddr & 0x0FFFFFFF;
      if (maskedWord === 0x04000400) this.ppu.gx.writeFifo(next);
      else this.ppu.gx.writeDirect(maskedWord, next);
    }
  }

  read32(addr: number): number {
    addr = addr >>> 0;
    if (this.isDmaAddr(addr)) return this.dma.read32(addr);
    if (this.math && this.isMathAddr(addr)) return this.math.read32(addr & 0x0FFFFFFF);
    if ((addr & 0x0FFFFFFC) === 0x04100000) {
      return this.ipc.readRecv(this.isArm9);
    }
    // ROMDATA at 0x04100010 (32-bit only, atomic word pop).
    if ((addr & 0x0FFFFFFC) === 0x04100010) {
      return this.cart.readRomData();
    }
    if ((addr & 0x0FFFFFFC) === 0x040001A4) {
      return this.cart.readRomCtrl();
    }
    const lo = this.read16(addr);
    const hi = this.read16((addr + 2) >>> 0);
    return ((hi << 16) | lo) >>> 0;
  }
  read16(addr: number): number {
    addr = addr >>> 0;
    if (this.isDmaAddr(addr)) return this.dma.read16(addr);
    if (this.math && this.isMathAddr(addr)) return this.math.read16(addr & 0x0FFFFFFF);
    if ((addr & 0x0FFFFFFF) === 0x04000180) return this.ipc.readSync(this.isArm9);
    if ((addr & 0x0FFFFFFF) === 0x04000184) return this.ipc.readCnt(this.isArm9);
    if ((addr & 0x0FFFFFFF) === 0x040001A0) return this.cart.readAuxSpiCnt();
    return (this.read8(addr) | (this.read8((addr + 1) >>> 0) << 8)) & 0xFFFF;
  }
  read8(addr: number): number {
    addr = addr & 0x0FFFFFFF;
    if (this.math && addr >= 0x04000280 && addr < 0x040002C0) return this.math.read8(addr);
    // ARM7 sound: 0x04000400-0x040005FF is the sound chip (the same
    // address range is GX for ARM9, but reads from GX ports return 0
    // on real hardware so this gate is safe).
    if (!this.isArm9 && addr >= 0x04000400 && addr < 0x04000600) {
      return this.sound.readByte(addr | 0x04000000);
    }
    if (addr >= 0x04000000 && addr < 0x04000004) {
      return (this.ppu.dispcntA >>> ((addr & 3) * 8)) & 0xFF;
    }
    if (addr >= 0x04001000 && addr < 0x04001004) {
      return (this.ppu.dispcntB >>> ((addr & 3) * 8)) & 0xFF;
    }
    // VRAMCNT_A..G at 0x240..0x246, WRAMCNT at 0x247, VRAMCNT_H..I at
    // 0x248..0x249. The ARM7-side mirror is VRAMSTAT at 0x240,
    // WRAMSTAT at 0x241.
    if (!this.isArm9) {
      if (addr === 0x04000240) return this.ppu.vramStat();
      if (addr === 0x04000241) return this.mem.wramcnt & 0xFF;
      if (addr >= 0x04000242 && addr < 0x0400024A) return 0;
    } else {
      if (addr >= 0x04000240 && addr < 0x04000247) return this.ppu.vramcnt[addr - 0x04000240];
      if (addr === 0x04000247) return this.mem.wramcnt & 0xFF;
      if (addr === 0x04000248) return this.ppu.vramcnt[7];
      if (addr === 0x04000249) return this.ppu.vramcnt[8];
    }
    // Engine A BG control + scroll: BG0CNT..BG3CNT at 0x08..0x0F,
    // BG0HOFS..BG3VOFS at 0x10..0x1F.
    if (addr >= 0x04000008 && addr < 0x04000010) {
      const bg = (addr - 0x04000008) >>> 1;
      const lo = addr & 1;
      return lo ? (this.ppu.bgCntA[bg] >>> 8) & 0xFF : this.ppu.bgCntA[bg] & 0xFF;
    }
    if (addr >= 0x04000010 && addr < 0x04000020) {
      const bg = (addr - 0x04000010) >>> 2;
      const sub = (addr - 0x04000010) & 0x3;
      const reg = sub < 2 ? this.ppu.bgHofsA[bg] : this.ppu.bgVofsA[bg];
      return (sub & 1) ? (reg >>> 8) & 0xFF : reg & 0xFF;
    }
    // Engine A window / blend / master-bright / display-capture reads.
    // Per GBATEK most of these are write-only; we still return the latch
    // so tests can verify the register was stored.
    if (addr >= 0x04000040 && addr < 0x04000048) {
      const reg = (addr - 0x04000040) >>> 1;
      const arr = reg < 2 ? this.ppu.winHA : this.ppu.winVA;
      const sub = reg & 1;
      return (addr & 1) ? (arr[sub] >>> 8) & 0xFF : arr[sub] & 0xFF;
    }
    if (addr === 0x04000048) return this.ppu.winInA  & 0xFF;
    if (addr === 0x04000049) return (this.ppu.winInA  >>> 8) & 0xFF;
    if (addr === 0x0400004A) return this.ppu.winOutA & 0xFF;
    if (addr === 0x0400004B) return (this.ppu.winOutA >>> 8) & 0xFF;
    if (addr === 0x04000050) return this.ppu.bldCntA   & 0xFF;
    if (addr === 0x04000051) return (this.ppu.bldCntA   >>> 8) & 0xFF;
    if (addr === 0x04000052) return this.ppu.bldAlphaA & 0xFF;
    if (addr === 0x04000053) return (this.ppu.bldAlphaA >>> 8) & 0xFF;
    if (addr === 0x04000054) return this.ppu.bldYA     & 0xFF;
    if (addr === 0x04000055) return (this.ppu.bldYA     >>> 8) & 0xFF;
    if (addr >= 0x04000064 && addr < 0x04000068) {
      return (this.ppu.dispCapCnt >>> ((addr & 3) * 8)) & 0xFF;
    }
    if (addr === 0x0400006C) return this.ppu.masterBrightA & 0xFF;
    if (addr === 0x0400006D) return (this.ppu.masterBrightA >>> 8) & 0xFF;
    // Engine B BG control/scroll mirror at 0x1008..0x101F.
    if (addr >= 0x04001008 && addr < 0x04001010) {
      const bg = (addr - 0x04001008) >>> 1;
      const lo = addr & 1;
      return lo ? (this.ppu.bgCntB[bg] >>> 8) & 0xFF : this.ppu.bgCntB[bg] & 0xFF;
    }
    if (addr >= 0x04001010 && addr < 0x04001020) {
      const bg = (addr - 0x04001010) >>> 2;
      const sub = (addr - 0x04001010) & 0x3;
      const reg = sub < 2 ? this.ppu.bgHofsB[bg] : this.ppu.bgVofsB[bg];
      return (sub & 1) ? (reg >>> 8) & 0xFF : reg & 0xFF;
    }
    // Engine B window / blend / master-bright reads.
    if (addr >= 0x04001040 && addr < 0x04001048) {
      const reg = (addr - 0x04001040) >>> 1;
      const arr = reg < 2 ? this.ppu.winHB : this.ppu.winVB;
      const sub = reg & 1;
      return (addr & 1) ? (arr[sub] >>> 8) & 0xFF : arr[sub] & 0xFF;
    }
    if (addr === 0x04001048) return this.ppu.winInB  & 0xFF;
    if (addr === 0x04001049) return (this.ppu.winInB  >>> 8) & 0xFF;
    if (addr === 0x0400104A) return this.ppu.winOutB & 0xFF;
    if (addr === 0x0400104B) return (this.ppu.winOutB >>> 8) & 0xFF;
    if (addr === 0x04001050) return this.ppu.bldCntB   & 0xFF;
    if (addr === 0x04001051) return (this.ppu.bldCntB   >>> 8) & 0xFF;
    if (addr === 0x04001052) return this.ppu.bldAlphaB & 0xFF;
    if (addr === 0x04001053) return (this.ppu.bldAlphaB >>> 8) & 0xFF;
    if (addr === 0x04001054) return this.ppu.bldYB     & 0xFF;
    if (addr === 0x04001055) return (this.ppu.bldYB     >>> 8) & 0xFF;
    if (addr === 0x0400106C) return this.ppu.masterBrightB & 0xFF;
    if (addr === 0x0400106D) return (this.ppu.masterBrightB >>> 8) & 0xFF;
    // Cart command bytes — 0x040001A8..0x040001AF.
    if (addr >= 0x040001A8 && addr < 0x040001B0) {
      return this.cart.readCmdByte(addr - 0x040001A8);
    }
    // Cart ROMCTRL byte access (decomposed) and AUXSPIDATA.
    if (addr >= 0x040001A4 && addr < 0x040001A8) {
      const shift = (addr & 3) * 8;
      return (this.cart.readRomCtrl() >>> shift) & 0xFF;
    }
    if (addr === 0x040001A2) return this.cart.readAuxSpiData();
    if (this.timers && addr >= 0x04000100 && addr < 0x04000110) {
      return this.timers.read8(addr - 0x04000100);
    }
    switch (addr) {
      case 0x04000004: return this.ppu.dispstat & 0xFF;
      case 0x04000005: return (this.ppu.dispstat >>> 8) & 0xFF;
      case 0x04000006: return this.ppu.vcount & 0xFF;
      case 0x04000007: return (this.ppu.vcount >>> 8) & 0x01;
      case 0x04000130: return this.keyinput & 0xFF;
      case 0x04000131: return (this.keyinput >>> 8) & 0xFF;
      case 0x04000138: return this.rtc.read() & 0xFF;
      case 0x04000139: return (this.rtc.read() >>> 8) & 0xFF;
      case 0x04000136: {
        // Pen-down on ARM7: bit 6 LOW = pressed. The actual touch state
        // lives on the SPI module (which the touchscreen ADC reads
        // from). When touchX/touchY are set, clear bit 6.
        let v = this.extKeyinput & 0xFF;
        if (this.spi && this.spi.touchX !== null && this.spi.touchY !== null) v &= ~0x40;
        return v;
      }
      case 0x04000137: return (this.extKeyinput >>> 8) & 0xFF;
      // IPCSYNC — fall back to the half-word reader.
      case 0x04000180: return this.ipc.readSync(this.isArm9) & 0xFF;
      case 0x04000181: return (this.ipc.readSync(this.isArm9) >>> 8) & 0xFF;
      // IPCFIFOCNT byte access.
      case 0x04000184: return this.ipc.readCnt(this.isArm9) & 0xFF;
      case 0x04000185: return (this.ipc.readCnt(this.isArm9) >>> 8) & 0xFF;
      // IE / IF / IME
      case 0x04000208: return this.irq.ime ? 1 : 0;
      case 0x04000209: case 0x0400020A: case 0x0400020B: return 0;
      case 0x04000210: return this.irq.ie & 0xFF;
      case 0x04000211: return (this.irq.ie >>> 8) & 0xFF;
      case 0x04000212: return (this.irq.ie >>> 16) & 0xFF;
      case 0x04000213: return (this.irq.ie >>> 24) & 0xFF;
      case 0x04000214: return this.irq.if_ & 0xFF;
      case 0x04000215: return (this.irq.if_ >>> 8) & 0xFF;
      case 0x04000216: return (this.irq.if_ >>> 16) & 0xFF;
      case 0x04000217: return (this.irq.if_ >>> 24) & 0xFF;
      case 0x04000300: return this.postflg & 0xFF;
      case 0x04000304: return this.powcnt1 & 0xFF;
      case 0x04000305: return (this.powcnt1 >>> 8) & 0xFF;
      case 0x04000306: return (this.powcnt1 >>> 16) & 0xFF;
      case 0x04000307: return (this.powcnt1 >>> 24) & 0xFF;
      // SPI bus (ARM7 only).
      case 0x040001C0: return this.spi ? this.spi.readCnt() & 0xFF       : 0;
      case 0x040001C1: return this.spi ? (this.spi.readCnt() >>> 8) & 0xFF : 0;
      case 0x040001C2: return this.spi ? this.spi.readData() & 0xFF     : 0;
      case 0x040001C3: return 0;
    }
    return 0;
  }

  write32(addr: number, v: number): void {
    addr = addr >>> 0;
    if (this.isDmaAddr(addr)) { this.dma.write32(addr, v); return; }
    if (this.math && this.isMathAddr(addr)) { this.math.write32(addr & 0x0FFFFFFF, v); return; }
    if ((addr & 0x0FFFFFFC) === 0x04000188) {
      this.ipc.writeSend(this.isArm9, v >>> 0);
      return;
    }
    if ((addr & 0x0FFFFFFC) === 0x040001A4) {
      this.cart.writeRomCtrl(v >>> 0);
      return;
    }
    // GX: GXFIFO (0x04000400, 32-bit only) and direct command ports
    // (0x04000440..0x040005FF). ARM9-only.
    if (this.isArm9) {
      const masked = addr & 0x0FFFFFFF;
      if (masked === 0x04000400) { this.ppu.gx.writeFifo(v >>> 0); return; }
      if (masked >= 0x04000440 && masked < 0x04000600) {
        this.ppu.gx.writeDirect(masked & ~0x3, v >>> 0);
        return;
      }
    }
    this.write16(addr, v & 0xFFFF);
    this.write16((addr + 2) >>> 0, (v >>> 16) & 0xFFFF);
  }
  write16(addr: number, v: number): void {
    addr = addr >>> 0;
    if (this.isDmaAddr(addr)) { this.dma.write16(addr, v); return; }
    if (this.math && this.isMathAddr(addr)) { this.math.write16(addr & 0x0FFFFFFF, v); return; }
    if ((addr & 0x0FFFFFFF) === 0x04000180) { this.ipc.writeSync(this.isArm9, v & 0xFFFF); return; }
    if ((addr & 0x0FFFFFFF) === 0x04000184) { this.ipc.writeCnt(this.isArm9, v & 0xFFFF);  return; }
    if ((addr & 0x0FFFFFFF) === 0x040001A0) { this.cart.writeAuxSpiCnt(v & 0xFFFF);         return; }
    // GX ports are 32-bit-only; accumulate half-word writes into the
    // surrounding word and fire when complete. ARM9-only.
    if (this.isArm9 && this.isGxAddr(addr)) {
      this.gxPartialWrite(addr, v & 0xFFFF, 2);
      return;
    }
    this.write8(addr, v & 0xFF);
    this.write8((addr + 1) >>> 0, (v >>> 8) & 0xFF);
  }
  write8(addr: number, v: number): void {
    addr = addr & 0x0FFFFFFF;
    if (this.isDmaAddr(addr | 0x04000000)) { this.dma.write8(addr, v); return; }
    if (this.math && addr >= 0x04000280 && addr < 0x040002C0) { this.math.write8(addr, v); return; }
    // GX ports are 32-bit-only; accumulate single bytes into the
    // surrounding word and fire when complete. ARM9-only.
    if (this.isArm9 && this.isGxAddr(addr | 0x04000000)) {
      this.gxPartialWrite(addr, v & 0xFF, 1);
      return;
    }
    // ARM7 sound: 0x04000400-0x040005FF.
    if (!this.isArm9 && addr >= 0x04000400 && addr < 0x04000600) {
      this.sound.writeByte(addr | 0x04000000, v);
      return;
    }
    if (addr >= 0x04000000 && addr < 0x04000004) {
      const shift = (addr & 3) * 8;
      this.ppu.dispcntA = ((this.ppu.dispcntA & ~(0xFF << shift)) | ((v & 0xFF) << shift)) >>> 0;
      return;
    }
    if (addr >= 0x04001000 && addr < 0x04001004) {
      const shift = (addr & 3) * 8;
      this.ppu.dispcntB = ((this.ppu.dispcntB & ~(0xFF << shift)) | ((v & 0xFF) << shift)) >>> 0;
      return;
    }
    if (addr >= 0x04000240 && addr < 0x0400024A) {
      // ARM7 writes are RO (it can only read VRAMSTAT / WRAMSTAT).
      if (!this.isArm9) return;
      if (addr < 0x04000247)        this.ppu.vramcnt[addr - 0x04000240] = v & 0xFF;
      else if (addr === 0x04000247) this.mem.wramcnt = v & 0x03;
      else if (addr === 0x04000248) this.ppu.vramcnt[7] = v & 0xFF;
      else if (addr === 0x04000249) this.ppu.vramcnt[8] = v & 0xFF;
      return;
    }
    // Engine A BG regs.
    if (addr >= 0x04000008 && addr < 0x04000010) {
      const bg = (addr - 0x04000008) >>> 1;
      const shift = (addr & 1) * 8;
      this.ppu.bgCntA[bg] = ((this.ppu.bgCntA[bg] & ~(0xFF << shift)) | ((v & 0xFF) << shift)) & 0xFFFF;
      return;
    }
    if (addr >= 0x04000010 && addr < 0x04000020) {
      const bg = (addr - 0x04000010) >>> 2;
      const sub = (addr - 0x04000010) & 0x3;
      const isHofs = sub < 2;
      const arr = isHofs ? this.ppu.bgHofsA : this.ppu.bgVofsA;
      const shift = (sub & 1) * 8;
      arr[bg] = ((arr[bg] & ~(0xFF << shift)) | ((v & 0xFF) << shift)) & 0xFFFF;
      return;
    }
    // Affine BG registers (Engine A): BG2 at 0x04000020..0x0400002F,
    // BG3 at 0x04000030..0x0400003F.
    if (addr >= 0x04000020 && addr < 0x04000040) {
      writeAffineByte(this.ppu, true, addr - 0x04000020, v & 0xFF);
      return;
    }
    // MOSAIC registers (engine A/B). 16-bit; layout is 4 nibbles —
    // BG H, BG V, OBJ H, OBJ V (each "size" = N - 1).
    if (addr === 0x0400004C) {
      this.ppu.mosaicA = (this.ppu.mosaicA & 0xFF00) | (v & 0xFF);
      return;
    }
    if (addr === 0x0400004D) {
      this.ppu.mosaicA = (this.ppu.mosaicA & 0x00FF) | ((v & 0xFF) << 8);
      return;
    }
    if (addr === 0x0400104C) {
      this.ppu.mosaicB = (this.ppu.mosaicB & 0xFF00) | (v & 0xFF);
      return;
    }
    if (addr === 0x0400104D) {
      this.ppu.mosaicB = (this.ppu.mosaicB & 0x00FF) | ((v & 0xFF) << 8);
      return;
    }
    // Window registers (engine A: 0x40..0x4B, engine B: 0x1040..0x104B).
    // WIN0H/WIN1H/WIN0V/WIN1V are 16-bit each; WININ/WINOUT are 16-bit.
    if (addr >= 0x04000040 && addr < 0x04000048) {
      const reg = (addr - 0x04000040) >>> 1;     // 0 = WIN0H, 1 = WIN1H, 2 = WIN0V, 3 = WIN1V
      const arr = reg < 2 ? this.ppu.winHA : this.ppu.winVA;
      const sub = reg & 1;
      const shift = (addr & 1) * 8;
      arr[sub] = ((arr[sub] & ~(0xFF << shift)) | ((v & 0xFF) << shift)) & 0xFFFF;
      return;
    }
    if (addr === 0x04000048) { this.ppu.winInA  = (this.ppu.winInA  & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x04000049) { this.ppu.winInA  = (this.ppu.winInA  & 0x00FF) | ((v & 0xFF) << 8); return; }
    if (addr === 0x0400004A) { this.ppu.winOutA = (this.ppu.winOutA & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x0400004B) { this.ppu.winOutA = (this.ppu.winOutA & 0x00FF) | ((v & 0xFF) << 8); return; }
    if (addr >= 0x04001040 && addr < 0x04001048) {
      const reg = (addr - 0x04001040) >>> 1;
      const arr = reg < 2 ? this.ppu.winHB : this.ppu.winVB;
      const sub = reg & 1;
      const shift = (addr & 1) * 8;
      arr[sub] = ((arr[sub] & ~(0xFF << shift)) | ((v & 0xFF) << shift)) & 0xFFFF;
      return;
    }
    if (addr === 0x04001048) { this.ppu.winInB  = (this.ppu.winInB  & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x04001049) { this.ppu.winInB  = (this.ppu.winInB  & 0x00FF) | ((v & 0xFF) << 8); return; }
    if (addr === 0x0400104A) { this.ppu.winOutB = (this.ppu.winOutB & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x0400104B) { this.ppu.winOutB = (this.ppu.winOutB & 0x00FF) | ((v & 0xFF) << 8); return; }
    // Color-special-effects: BLDCNT (0x50/0x1050), BLDALPHA (0x52/0x1052),
    // BLDY (0x54/0x1054). All 16-bit; we accept any byte slice.
    if (addr === 0x04000050) { this.ppu.bldCntA   = (this.ppu.bldCntA   & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x04000051) { this.ppu.bldCntA   = (this.ppu.bldCntA   & 0x00FF) | ((v & 0xFF) << 8); return; }
    if (addr === 0x04000052) { this.ppu.bldAlphaA = (this.ppu.bldAlphaA & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x04000053) { this.ppu.bldAlphaA = (this.ppu.bldAlphaA & 0x00FF) | ((v & 0xFF) << 8); return; }
    if (addr === 0x04000054) { this.ppu.bldYA     = (this.ppu.bldYA     & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x04000055) { this.ppu.bldYA     = (this.ppu.bldYA     & 0x00FF) | ((v & 0xFF) << 8); return; }
    if (addr === 0x04001050) { this.ppu.bldCntB   = (this.ppu.bldCntB   & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x04001051) { this.ppu.bldCntB   = (this.ppu.bldCntB   & 0x00FF) | ((v & 0xFF) << 8); return; }
    if (addr === 0x04001052) { this.ppu.bldAlphaB = (this.ppu.bldAlphaB & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x04001053) { this.ppu.bldAlphaB = (this.ppu.bldAlphaB & 0x00FF) | ((v & 0xFF) << 8); return; }
    if (addr === 0x04001054) { this.ppu.bldYB     = (this.ppu.bldYB     & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x04001055) { this.ppu.bldYB     = (this.ppu.bldYB     & 0x00FF) | ((v & 0xFF) << 8); return; }
    // MASTER_BRIGHT (engine A 0x0400006C, engine B 0x0400106C). 16-bit.
    if (addr === 0x0400006C) { this.ppu.masterBrightA = (this.ppu.masterBrightA & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x0400006D) { this.ppu.masterBrightA = (this.ppu.masterBrightA & 0x00FF) | ((v & 0xFF) << 8); return; }
    if (addr === 0x0400106C) { this.ppu.masterBrightB = (this.ppu.masterBrightB & 0xFF00) | (v & 0xFF); return; }
    if (addr === 0x0400106D) { this.ppu.masterBrightB = (this.ppu.masterBrightB & 0x00FF) | ((v & 0xFF) << 8); return; }
    // DISPCAPCNT (engine A only, 0x04000064, 32-bit).
    if (addr >= 0x04000064 && addr < 0x04000068) {
      const shift = (addr & 3) * 8;
      this.ppu.dispCapCnt = ((this.ppu.dispCapCnt & ~(0xFF << shift)) | ((v & 0xFF) << shift)) >>> 0;
      return;
    }
    // 3D engine control + post-process tables. These all live on the
    // ARM9 side; reads/writes from ARM7 are no-ops on hardware (GBATEK
    // §"3D Display Engine"). We gate on isArm9 to match.
    if (this.isArm9) {
      // DISP3DCNT (0x04000060, 16-bit). Bit 5 = edge marking, bit 7 = fog.
      if (addr === 0x04000060) {
        this.ppu.gx.dispCnt3D = (this.ppu.gx.dispCnt3D & 0xFF00) | (v & 0xFF);
        return;
      }
      if (addr === 0x04000061) {
        this.ppu.gx.dispCnt3D = (this.ppu.gx.dispCnt3D & 0x00FF) | ((v & 0xFF) << 8);
        return;
      }
      // EDGE_COLOR_TABLE (0x04000330..0x0400033F, 8 × BGR555).
      if (addr >= 0x04000330 && addr < 0x04000340) {
        const idx = (addr - 0x04000330) >>> 1;
        const shift = (addr & 1) * 8;
        this.ppu.gx.edgeColorTable[idx] =
          ((this.ppu.gx.edgeColorTable[idx] & ~(0xFF << shift)) | ((v & 0xFF) << shift)) & 0xFFFF;
        return;
      }
      // FOG_COLOR (0x04000358, 32-bit). Only the low 15 bits are color
      // (BGR555); upper bits include a 5-bit alpha that we ignore for
      // now (no per-pixel alpha through the rasterizer yet).
      if (addr >= 0x04000358 && addr < 0x0400035C) {
        const shift = (addr & 3) * 8;
        this.ppu.gx.fogColor =
          ((this.ppu.gx.fogColor & ~(0xFF << shift)) | ((v & 0xFF) << shift)) & 0x7FFF;
        return;
      }
      // FOG_OFFSET (0x0400035C, 16-bit). 15-bit Z reference.
      if (addr === 0x0400035C) {
        this.ppu.gx.fogOffset = (this.ppu.gx.fogOffset & 0xFF00) | (v & 0xFF);
        return;
      }
      if (addr === 0x0400035D) {
        this.ppu.gx.fogOffset = (this.ppu.gx.fogOffset & 0x00FF) | ((v & 0xFF) << 8);
        return;
      }
      // FOG_TABLE (0x04000360..0x0400037F, 32 × 7-bit density bytes).
      if (addr >= 0x04000360 && addr < 0x04000380) {
        this.ppu.gx.fogTable[addr - 0x04000360] = v & 0x7F;
        return;
      }
    }
    // Engine B BG regs.
    if (addr >= 0x04001008 && addr < 0x04001010) {
      const bg = (addr - 0x04001008) >>> 1;
      const shift = (addr & 1) * 8;
      this.ppu.bgCntB[bg] = ((this.ppu.bgCntB[bg] & ~(0xFF << shift)) | ((v & 0xFF) << shift)) & 0xFFFF;
      return;
    }
    if (addr >= 0x04001010 && addr < 0x04001020) {
      const bg = (addr - 0x04001010) >>> 2;
      const sub = (addr - 0x04001010) & 0x3;
      const isHofs = sub < 2;
      const arr = isHofs ? this.ppu.bgHofsB : this.ppu.bgVofsB;
      const shift = (sub & 1) * 8;
      arr[bg] = ((arr[bg] & ~(0xFF << shift)) | ((v & 0xFF) << shift)) & 0xFFFF;
      return;
    }
    // Affine BG registers (Engine B): BG2 at 0x04001020..0x0400102F,
    // BG3 at 0x04001030..0x0400103F.
    if (addr >= 0x04001020 && addr < 0x04001040) {
      writeAffineByte(this.ppu, false, addr - 0x04001020, v & 0xFF);
      return;
    }
    if (addr >= 0x040001A8 && addr < 0x040001B0) {
      this.cart.writeCmdByte(addr - 0x040001A8, v & 0xFF);
      return;
    }
    if (addr >= 0x040001A4 && addr < 0x040001A8) {
      const shift = (addr & 3) * 8;
      const cur = this.cart.readRomCtrl();
      this.cart.writeRomCtrl(((cur & ~(0xFF << shift)) | ((v & 0xFF) << shift)) >>> 0);
      return;
    }
    if (addr === 0x040001A2) { this.cart.writeAuxSpiData(v & 0xFF); return; }
    if (this.timers && addr >= 0x04000100 && addr < 0x04000110) {
      this.timers.write8(addr - 0x04000100, v & 0xFF);
      return;
    }
    switch (addr) {
      case 0x04000004: this.ppu.dispstat = (this.ppu.dispstat & 0xFF00) | (v & 0xFF); return;
      case 0x04000005: this.ppu.dispstat = (this.ppu.dispstat & 0x00FF) | ((v & 0xFF) << 8); return;
      // IPCSYNC byte writes — assemble + delegate.
      case 0x04000180: {
        const cur = this.ipc.readSync(this.isArm9);
        this.ipc.writeSync(this.isArm9, (cur & 0xFF00) | (v & 0xFF));
        return;
      }
      case 0x04000181: {
        const cur = this.ipc.readSync(this.isArm9);
        this.ipc.writeSync(this.isArm9, (cur & 0x00FF) | ((v & 0xFF) << 8));
        return;
      }
      case 0x04000184: {
        const cur = this.ipc.readCnt(this.isArm9);
        this.ipc.writeCnt(this.isArm9, (cur & 0xFF00) | (v & 0xFF));
        return;
      }
      case 0x04000185: {
        const cur = this.ipc.readCnt(this.isArm9);
        this.ipc.writeCnt(this.isArm9, (cur & 0x00FF) | ((v & 0xFF) << 8));
        return;
      }
      case 0x04000208: this.irq.setIme(v & 1); return;
      case 0x04000210: this.irq.setIe((this.irq.ie & 0xFFFFFF00) | (v & 0xFF)); return;
      case 0x04000211: this.irq.setIe((this.irq.ie & 0xFFFF00FF) | ((v & 0xFF) << 8)); return;
      case 0x04000212: this.irq.setIe((this.irq.ie & 0xFF00FFFF) | ((v & 0xFF) << 16)); return;
      case 0x04000213: this.irq.setIe((this.irq.ie & 0x00FFFFFF) | ((v & 0xFF) << 24)); return;
      case 0x04000214: this.irq.ackIf(v & 0xFF); return;
      case 0x04000215: this.irq.ackIf((v & 0xFF) << 8); return;
      case 0x04000216: this.irq.ackIf((v & 0xFF) << 16); return;
      case 0x04000217: this.irq.ackIf((v & 0xFF) << 24); return;
      case 0x04000138: this.rtc.write((this.rtc.read() & 0xFF00) | (v & 0xFF)); return;
      case 0x04000139: this.rtc.write((this.rtc.read() & 0x00FF) | ((v & 0xFF) << 8)); return;
      case 0x04000300: this.postflg = v & 0xFF; return;
      case 0x04000304: this.powcnt1 = (this.powcnt1 & ~0xFF)         | (v & 0xFF);        return;
      case 0x04000305: this.powcnt1 = (this.powcnt1 & ~0xFF00)       | ((v & 0xFF) << 8); return;
      case 0x04000306: this.powcnt1 = (this.powcnt1 & ~0xFF0000)     | ((v & 0xFF) << 16); return;
      case 0x04000307: this.powcnt1 = (this.powcnt1 & ~0xFF000000)   | ((v & 0xFF) << 24); return;
      case 0x04000301: {
        // HALTCNT — bit 7 = HALT, bit 6 = GBA-mode (we don't implement),
        // 0x40 = sleep. Treat any of the halt-class bits as "halt CPU".
        // Real BIOS clears CPSR.I before writing HALTCNT; if it didn't,
        // the CPU couldn't wake — match that by unmasking IRQs here too,
        // mirroring the bios HLE halt() path.
        this.haltcnt = v & 0xFF;
        if ((v & 0x80) !== 0 || (v & 0x40) !== 0) {
          // We don't have a direct CPU reference here; instead arm a
          // pending halt via the irq controller's IME unmask + cpu's
          // halt() side-channel. Both happen at frame-boundary time —
          // the bios.attachCpu link gives us that.
          if (this.bios) this.bios.halt();
        }
        return;
      }
      // SPI bus (ARM7 only). CNT is two bytes assembled, DATA is one
      // byte that triggers a transfer.
      case 0x040001C0: if (this.spi) { const c = this.spi.readCnt(); this.spi.writeCnt((c & 0xFF00) | (v & 0xFF)); } return;
      case 0x040001C1: if (this.spi) { const c = this.spi.readCnt(); this.spi.writeCnt((c & 0x00FF) | ((v & 0xFF) << 8)); } return;
      case 0x040001C2: if (this.spi) this.spi.writeData(v & 0xFF); return;
      case 0x040001C3: return;
    }
  }
}

// Affine BG IO byte writer. `relOff` is the address relative to the
// per-engine affine block (0 = BG2PA low, … 0x1F = BG3Y high). Layout:
//   0x00..0x07  BG2 PA / PB / PC / PD (16-bit signed Q8.8 each)
//   0x08..0x0B  BG2X (28-bit signed Q20.8, sign-extended from bit 27)
//   0x0C..0x0F  BG2Y
//   0x10..0x17  BG3 PA / PB / PC / PD
//   0x18..0x1B  BG3X
//   0x1C..0x1F  BG3Y
//
// Per GBATEK, writing to BG2X / BG2Y / BG3X / BG3Y *re-latches* the
// running reference position immediately — subsequent HBlanks resume
// PB/PD accumulation from the new value. Half-word writes still cause
// a relatch on whichever byte triggers it, matching what most games do
// (they write the full 32-bit X via str/strh anyway).
function writeAffineByte(ppu: Ppu, isEngineA: boolean, relOff: number, byteVal: number): void {
  const bg = (relOff & 0x10) !== 0 ? 3 : 2;
  const inner = relOff & 0x0F;
  const v = byteVal & 0xFF;
  const pa = isEngineA ? ppu.bgPA_A : ppu.bgPA_B;
  const pb = isEngineA ? ppu.bgPB_A : ppu.bgPB_B;
  const pc = isEngineA ? ppu.bgPC_A : ppu.bgPC_B;
  const pd = isEngineA ? ppu.bgPD_A : ppu.bgPD_B;
  const rx = isEngineA ? ppu.bgRefX_A : ppu.bgRefX_B;
  const ry = isEngineA ? ppu.bgRefY_A : ppu.bgRefY_B;
  const rxL = isEngineA ? ppu.bgRefXLatched_A : ppu.bgRefXLatched_B;
  const ryL = isEngineA ? ppu.bgRefYLatched_A : ppu.bgRefYLatched_B;

  if (inner < 8) {
    // PA / PB / PC / PD halves. inner 0..1 = PA lo/hi, 2..3 = PB, etc.
    const which = inner >>> 1;
    const isHi = (inner & 1) === 1;
    const arr = which === 0 ? pa : which === 1 ? pb : which === 2 ? pc : pd;
    const cur = arr[bg] & 0xFFFF;
    const next = isHi ? ((cur & 0x00FF) | (v << 8)) : ((cur & 0xFF00) | v);
    // Int16Array auto-sign-extends on store.
    arr[bg] = next as number;
    return;
  }
  // BGxX (inner 8..B) or BGxY (inner C..F) — 28-bit signed, stored in
  // an Int32Array. The low 24 bits are the integer "tile/pixel" portion;
  // bit 27 is the sign. We sign-extend on EVERY byte write so even a
  // mid-word partial write of the high byte settles the sign correctly.
  const isY = (inner & 0x4) !== 0;
  const refArr   = isY ? ry  : rx;
  const refArrL  = isY ? ryL : rxL;
  const byteIdx = inner & 0x3;
  const cur = refArr[bg] >>> 0;             // unsigned 32 view
  const mask = ~(0xFF << (byteIdx * 8)) >>> 0;
  let next = ((cur & mask) | (v << (byteIdx * 8))) >>> 0;
  // 28-bit field: clear bits 28..31 and sign-extend from bit 27.
  next &= 0x0FFFFFFF;
  if ((next & 0x08000000) !== 0) next |= 0xF0000000;
  refArr[bg]  = next | 0;
  // Re-latch: subsequent HBlanks resume PB/PD accumulation from this
  // new reference value, matching real-hardware "write-to-X re-latches".
  refArrL[bg] = next | 0;
}
