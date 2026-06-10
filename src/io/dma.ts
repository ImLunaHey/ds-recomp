// DMA controller — 4 channels per CPU. Each channel has source, dest,
// word-count, and a 16-bit control with timing (immediate / VBlank /
// HBlank / cart / GXFIFO / line-render-start), src/dst increment mode,
// 16- vs 32-bit transfer, repeat, IRQ-on-finish, and an enable bit.
//
// For now we implement only the immediate-mode trigger (timing=0)
// and the VBlank-triggered variant. HBlank, cart, GXFIFO timings come
// next.

import type { ArmBus } from '../cpu/bus';
import { Irq, IRQ_DMA0 } from './irq';

const TIMING_IMMEDIATE = 0;
const TIMING_VBLANK    = 1;
const TIMING_HBLANK    = 2;
const TIMING_CARDREADY = 5;     // ARM9 only

interface DmaChannel {
  src: number;
  dst: number;
  countCtrl: number;     // 32-bit DMACNT (word count in low bits, control in high)
  // Latched copy of count when channel was enabled — for repeat the
  // count is reloaded from this when timing fires again.
  countLatched: number;
  srcLatched: number;
  dstLatched: number;
  enabled: boolean;
  timing: number;
  // 0=incr, 1=decr, 2=fixed, 3=incr+reload
  srcMode: number;
  dstMode: number;
  repeat: boolean;
  word32: boolean;
  irqOnDone: boolean;
}

export class Dma {
  bus: ArmBus;
  irq: Irq;
  isArm9: boolean;
  channels: DmaChannel[] = Array.from({ length: 4 }, () => ({
    src: 0, dst: 0, countCtrl: 0,
    countLatched: 0, srcLatched: 0, dstLatched: 0,
    enabled: false, timing: 0, srcMode: 0, dstMode: 0,
    repeat: false, word32: false, irqOnDone: false,
  }));

  constructor(bus: ArmBus, irq: Irq, isArm9: boolean) {
    this.bus = bus;
    this.irq = irq;
    this.isArm9 = isArm9;
  }

  // Byte address layout (per channel n, where n in 0..3):
  //   ARM9: SRC=0xB0+0Ch*n   DST=0xB4+0Ch*n   CNT=0xB8+0Ch*n
  //   ARM7 has the same layout offset from 0x040000B0.
  // The control half-word lives in the high half of CNT (0xBA).
  channelForAddr(addr: number): { ch: number; off: number } | null {
    const lo = addr & 0xFF;
    if (lo < 0xB0 || lo >= 0xE0) return null;
    const rel = lo - 0xB0;
    const ch = (rel / 12) | 0;
    if (ch > 3) return null;
    return { ch, off: rel - ch * 12 };
  }

  read32(addr: number): number {
    const m = this.channelForAddr(addr);
    if (!m) return 0;
    const c = this.channels[m.ch];
    if (m.off === 0) return c.src >>> 0;
    if (m.off === 4) return c.dst >>> 0;
    return c.countCtrl >>> 0;
  }
  read16(addr: number): number {
    const m = this.channelForAddr(addr);
    if (!m) return 0;
    const c = this.channels[m.ch];
    // Half-word access to any of SRC / DST / CNT.
    if (m.off === 0)  return c.src & 0xFFFF;
    if (m.off === 2)  return (c.src >>> 16) & 0xFFFF;
    if (m.off === 4)  return c.dst & 0xFFFF;
    if (m.off === 6)  return (c.dst >>> 16) & 0xFFFF;
    if (m.off === 8)  return c.countCtrl & 0xFFFF;
    if (m.off === 10) return (c.countCtrl >>> 16) & 0xFFFF;
    return 0;
  }
  read8(addr: number): number {
    const m = this.channelForAddr(addr);
    if (!m) return 0;
    const c = this.channels[m.ch];
    const shift = (m.off & 3) * 8;
    if (m.off < 4)      return (c.src >>> shift) & 0xFF;
    if (m.off < 8)      return (c.dst >>> shift) & 0xFF;
    return (c.countCtrl >>> shift) & 0xFF;
  }

  write32(addr: number, value: number): void {
    const m = this.channelForAddr(addr);
    if (!m) return;
    const c = this.channels[m.ch];
    if (m.off === 0) { c.src = value >>> 0; return; }
    if (m.off === 4) { c.dst = value >>> 0; return; }
    this.applyCount(c, value >>> 0);
  }
  write16(addr: number, value: number): void {
    const m = this.channelForAddr(addr);
    if (!m) return;
    const c = this.channels[m.ch];
    if (m.off === 8)  { this.applyCount(c, (c.countCtrl & 0xFFFF0000) | (value & 0xFFFF)); return; }
    if (m.off === 10) { this.applyCount(c, (c.countCtrl & 0x0000FFFF) | ((value & 0xFFFF) << 16)); return; }
  }
  write8(addr: number, value: number): void {
    const m = this.channelForAddr(addr);
    if (!m) return;
    const c = this.channels[m.ch];
    const shift = (m.off & 3) * 8;
    if (m.off < 4)       c.src = ((c.src & ~(0xFF << shift)) | ((value & 0xFF) << shift)) >>> 0;
    else if (m.off < 8)  c.dst = ((c.dst & ~(0xFF << shift)) | ((value & 0xFF) << shift)) >>> 0;
    else                 this.applyCount(c, ((c.countCtrl & ~(0xFF << shift)) | ((value & 0xFF) << shift)) >>> 0);
  }

  private applyCount(c: DmaChannel, value: number): void {
    const wasEnabled = c.enabled;
    c.countCtrl = value >>> 0;
    const ctrl = (value >>> 16) & 0xFFFF;
    c.dstMode = (ctrl >>> 5) & 0x3;
    c.srcMode = (ctrl >>> 7) & 0x3;
    c.repeat  = ((ctrl >>> 9) & 1) !== 0;
    c.word32  = ((ctrl >>> 10) & 1) !== 0;
    // ARM9 DMA timing is bits 11..13 (3 bits); ARM7 only uses bits 12..13 (2 bits).
    c.timing  = this.isArm9 ? ((ctrl >>> 11) & 0x7) : ((ctrl >>> 12) & 0x3);
    c.irqOnDone = ((ctrl >>> 14) & 1) !== 0;
    c.enabled = ((ctrl >>> 15) & 1) !== 0;

    if (!wasEnabled && c.enabled) {
      // Latch source/dest/count for repeat reloads.
      c.srcLatched = c.src;
      c.dstLatched = c.dst;
      c.countLatched = value & 0xFFFF;     // word count in low 16 bits
      if (c.timing === TIMING_IMMEDIATE) this.runChannel(c, this.channels.indexOf(c));
    }
  }

  // Run one full transfer for a channel. Doesn't model the cycle cost
  // — it's atomic from the CPU's perspective.
  private runChannel(c: DmaChannel, idx: number): void {
    const wordCount = c.countLatched === 0 ? (this.isArm9 ? 0x200000 : 0x10000) : c.countLatched;
    const step = c.word32 ? 4 : 2;
    let src = c.src >>> 0;
    let dst = c.dst >>> 0;
    for (let i = 0; i < wordCount; i++) {
      if (c.word32) {
        const v = this.bus.read32(src & ~3);
        this.bus.write32(dst & ~3, v);
      } else {
        const v = this.bus.read16(src & ~1);
        this.bus.write16(dst & ~1, v);
      }
      // Step source.
      if (c.srcMode === 0) src = (src + step) >>> 0;
      else if (c.srcMode === 1) src = (src - step) >>> 0;
      // Step dest.
      if (c.dstMode === 0) dst = (dst + step) >>> 0;
      else if (c.dstMode === 1) dst = (dst - step) >>> 0;
      // Real DS DMA updates DAD/SAD as the transfer progresses. Games
      // that poll the registers expect to see them change. We do an
      // atomic transfer so we can't model the per-cycle update — but
      // a final writeback after every 64-word chunk keeps the visible
      // state close enough for the polling patterns we've observed.
      if ((i & 0x3F) === 0x3F) {
        if (c.srcMode !== 3) c.src = src;
        if (c.dstMode !== 3) c.dst = dst;
      }
    }
    // Writeback (only when src/dst-mode 3 reload; otherwise keep moved values).
    if (c.srcMode !== 3) c.src = src;
    if (c.dstMode !== 3) c.dst = dst;
    // Repeat reloads use latched values.
    if (c.dstMode === 3) c.dst = c.dstLatched;
    if (c.repeat) {
      // Repeat keeps the enable bit set; just leave timing armed.
    } else {
      c.enabled = false;
      c.countCtrl = (c.countCtrl & 0x7FFFFFFF) >>> 0;     // clear enable
    }
    // Per-channel completion IRQ — IRQ_DMA0..3 are bits 8..11. Pokemon
    // Platinum's save-loaded boot path waits on a flag set by the DMA2
    // completion handler, so without firing these the title-screen
    // setup never runs.
    if (c.irqOnDone) this.irq.raise(IRQ_DMA0 << idx);
  }

  // Called by PPU when entering VBlank / HBlank — fires every channel
  // whose timing matches.
  triggerVBlank(): void { this.fireTiming(TIMING_VBLANK); }
  triggerHBlank(): void { this.fireTiming(TIMING_HBLANK); }
  triggerCardReady(): void { if (this.isArm9) this.fireTiming(TIMING_CARDREADY); }

  private fireTiming(t: number): void {
    for (let i = 0; i < this.channels.length; i++) {
      const c = this.channels[i];
      if (c.enabled && c.timing === t) this.runChannel(c, i);
    }
  }
}
