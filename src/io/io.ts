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
import type { SharedMemory } from '../memory/shared';
import type { Ipc } from './ipc';
import type { Cart } from '../cart/cart';
import type { Dma } from './dma';
import type { DsMath } from './ds_math';

export class IoBus {
  irq: Irq;
  ppu: Ppu;
  mem: SharedMemory;
  ipc: Ipc;
  cart: Cart;
  dma: Dma;
  math: DsMath | null;     // ARM9 only — null on the ARM7 side
  isArm9: boolean;
  // POSTFLG — set to 1 once the boot completes. Some games poll this.
  postflg = 0;
  // HALTCNT — write 0x80 puts the CPU into halt.
  haltcnt = 0;
  // Captured KEYINPUT — bits LOW = pressed. Default all up = 0x3FF.
  keyinput = 0x03FF;
  extKeyinput = 0x007F;   // X, Y, lid open (low = active)

  constructor(irq: Irq, ppu: Ppu, mem: SharedMemory, ipc: Ipc, cart: Cart, dma: Dma, math: DsMath | null, isArm9: boolean) {
    this.irq = irq;
    this.ppu = ppu;
    this.mem = mem;
    this.ipc = ipc;
    this.cart = cart;
    this.dma = dma;
    this.math = math;
    this.isArm9 = isArm9;
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
    if (addr >= 0x04000000 && addr < 0x04000004) {
      return (this.ppu.dispcntA >>> ((addr & 3) * 8)) & 0xFF;
    }
    if (addr >= 0x04001000 && addr < 0x04001004) {
      return (this.ppu.dispcntB >>> ((addr & 3) * 8)) & 0xFF;
    }
    if (addr >= 0x04000240 && addr < 0x04000249) {
      return this.ppu.vramcnt[addr - 0x04000240];
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
    switch (addr) {
      case 0x04000004: return this.ppu.dispstat & 0xFF;
      case 0x04000005: return (this.ppu.dispstat >>> 8) & 0xFF;
      case 0x04000006: return this.ppu.vcount & 0xFF;
      case 0x04000007: return (this.ppu.vcount >>> 8) & 0x01;
      case 0x04000130: return this.keyinput & 0xFF;
      case 0x04000131: return (this.keyinput >>> 8) & 0xFF;
      case 0x04000136: return this.extKeyinput & 0xFF;
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
      case 0x04000247: return this.mem.wramcnt & 0xFF;
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
    this.write8(addr, v & 0xFF);
    this.write8((addr + 1) >>> 0, (v >>> 8) & 0xFF);
  }
  write8(addr: number, v: number): void {
    addr = addr & 0x0FFFFFFF;
    if (this.isDmaAddr(addr | 0x04000000)) { this.dma.write8(addr, v); return; }
    if (this.math && addr >= 0x04000280 && addr < 0x040002C0) { this.math.write8(addr, v); return; }
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
    if (addr >= 0x04000240 && addr < 0x04000249) {
      this.ppu.vramcnt[addr - 0x04000240] = v & 0xFF;
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
      case 0x04000247: this.mem.wramcnt = v & 0x03; return;
      case 0x04000300: this.postflg = v & 0xFF; return;
      case 0x04000301: this.haltcnt = v & 0xFF; return;
    }
  }
}
