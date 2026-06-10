// Four hardware timers per CPU. Each has a 16-bit counter that ticks
// from a programmable reload value up to 0x10000, then overflows back
// to the reload, optionally raising an IRQ. The clock source is the
// system clock (33.5 MHz nominal — we use ARM9 cycles as the same
// 1:1 base, same as the PPU) divided by a per-timer prescaler.
// Cascade mode lets a higher timer count overflows of its predecessor
// instead of clock ticks.
//
// We model state as (counter, reload, control) and advance once per
// scheduled tick from runFrame() — Cpu cycles → timer ticks.

import type { Irq } from './irq';
import { IRQ_TIMER0, IRQ_TIMER1, IRQ_TIMER2, IRQ_TIMER3 } from './irq';

const PRESCALER_SHIFTS = [0, 6, 8, 10];   // /1, /64, /256, /1024

export class Timers {
  irq: Irq;
  counter = new Uint32Array(4);    // 16-bit each but Uint32 simpler
  reload  = new Uint32Array(4);
  cnt     = new Uint16Array(4);
  // Fractional cycles toward the next tick for each (non-cascade) timer.
  frac = new Float64Array(4);

  constructor(irq: Irq) {
    this.irq = irq;
  }

  // Reads/writes are byte-granularity; the IoBus router routes here.
  read8(reg: number): number {
    const t = (reg >> 2) & 0x3;
    const sub = reg & 0x3;
    if (sub === 0) return this.counter[t] & 0xFF;
    if (sub === 1) return (this.counter[t] >> 8) & 0xFF;
    if (sub === 2) return this.cnt[t] & 0xFF;
    return (this.cnt[t] >> 8) & 0xFF;
  }

  write8(reg: number, v: number): void {
    const t = (reg >> 2) & 0x3;
    const sub = reg & 0x3;
    v &= 0xFF;
    if (sub === 0) this.reload[t] = (this.reload[t] & 0xFF00) | v;
    else if (sub === 1) this.reload[t] = (this.reload[t] & 0x00FF) | (v << 8);
    else if (sub === 2) {
      const wasEnabled = (this.cnt[t] & 0x80) !== 0;
      const newCnt = (this.cnt[t] & 0xFF00) | v;
      this.cnt[t] = newCnt;
      // Rising-edge enable: snapshot the reload into the counter.
      if (!wasEnabled && (newCnt & 0x80) !== 0) {
        this.counter[t] = this.reload[t] & 0xFFFF;
        this.frac[t] = 0;
      }
    } else {
      this.cnt[t] = (this.cnt[t] & 0x00FF) | (v << 8);
    }
  }

  // Tick all enabled timers by `cycles` ARM cycles.
  step(cycles: number): void {
    for (let t = 0; t < 4; t++) {
      if ((this.cnt[t] & 0x80) === 0) continue;
      if ((this.cnt[t] & 0x04) !== 0 && t > 0) continue;   // cascade — driven by t-1
      const shift = PRESCALER_SHIFTS[this.cnt[t] & 0x03];
      const ticksFrac = this.frac[t] + cycles / (1 << shift);
      const ticks = Math.floor(ticksFrac);
      this.frac[t] = ticksFrac - ticks;
      this.advance(t, ticks);
    }
  }

  private advance(t: number, ticks: number): void {
    let c = this.counter[t] + ticks;
    while (c >= 0x10000) {
      c = c - 0x10000 + this.reload[t];
      // IRQ on overflow if enabled.
      if ((this.cnt[t] & 0x40) !== 0) {
        const bit = [IRQ_TIMER0, IRQ_TIMER1, IRQ_TIMER2, IRQ_TIMER3][t];
        this.irq.raise(bit);
      }
      // Cascade: bump the next timer's counter by 1.
      if (t < 3 && (this.cnt[t + 1] & 0x84) === 0x84) {
        this.advance(t + 1, 1);
      }
    }
    this.counter[t] = c;
  }
}
