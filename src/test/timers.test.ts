// Hardware-timer unit tests. Each timer is a 16-bit up-counter that
// reloads when it overflows 0x10000; cascade mode chains one timer to
// the next, and optional IRQ-on-overflow raises IRQ_TIMER0..3.

import { describe, it, expect, beforeEach } from 'vitest';
import { Timers } from '../io/timers';
import { Irq, IRQ_TIMER0, IRQ_TIMER1, IRQ_TIMER3 } from '../io/irq';

// IO byte register layout per timer (offset from this timer's base):
//   +0,+1 → reload (lo, hi)
//   +2    → CNT low byte (prescaler + cascade + IRQ + enable)
//   +3    → CNT high byte (unused on real hw)

function enable(t: Timers, idx: number, ctrl: number): void {
  t.write8(idx * 4 + 2, ctrl);
}

function setReload(t: Timers, idx: number, value: number): void {
  t.write8(idx * 4 + 0, value & 0xFF);
  t.write8(idx * 4 + 1, (value >>> 8) & 0xFF);
}

describe('Timers', () => {
  let irq: Irq;
  let timers: Timers;
  beforeEach(() => {
    irq = new Irq();
    timers = new Timers(irq);
  });

  it('timer 0 counts ARM cycles at /1 prescaler from reload', () => {
    setReload(timers, 0, 0xFF00);
    enable(timers, 0, 0x80);            // prescaler=0 (/1), enable
    timers.step(100);
    // Counter started at reload (0xFF00) then advanced 100 ticks → 0xFF64.
    expect(timers.counter[0]).toBe(0xFF00 + 100);
  });

  it('prescaler 64 (cnt&3=1) ticks once every 64 cycles', () => {
    setReload(timers, 0, 0);
    enable(timers, 0, 0x80 | 1);        // /64
    timers.step(128);
    expect(timers.counter[0]).toBe(2);
    timers.step(63);
    // 63 more cycles → 0.98 more ticks → still 2.
    expect(timers.counter[0]).toBe(2);
    timers.step(1);                     // accumulated fractional → 1 more tick
    expect(timers.counter[0]).toBe(3);
  });

  it('prescaler 256 and 1024 produce slower tick rates', () => {
    setReload(timers, 1, 0);
    enable(timers, 1, 0x80 | 2);        // /256
    timers.step(256 * 5);
    expect(timers.counter[1]).toBe(5);

    setReload(timers, 2, 0);
    enable(timers, 2, 0x80 | 3);        // /1024
    timers.step(1024 * 3);
    expect(timers.counter[2]).toBe(3);
  });

  it('timer overflows back to the reload value (no underflow past 0)', () => {
    setReload(timers, 0, 0xFFF0);
    enable(timers, 0, 0x80);            // /1
    timers.step(0x10);                  // 0xFFF0 + 0x10 = 0x10000 → overflow → reload 0xFFF0
    expect(timers.counter[0]).toBe(0xFFF0);
    // Sanity: counter is still in 16-bit range after overflow.
    expect(timers.counter[0]).toBeLessThan(0x10000);
  });

  it('cascade: timer 1 only advances when timer 0 overflows', () => {
    setReload(timers, 0, 0xFFFE);
    enable(timers, 0, 0x80);            // /1
    setReload(timers, 1, 0);
    enable(timers, 1, 0x80 | 0x04);     // cascade=count-up from t0
    timers.step(1);
    // t0 = 0xFFFF, t1 still 0.
    expect(timers.counter[0]).toBe(0xFFFF);
    expect(timers.counter[1]).toBe(0);
    timers.step(2);                     // overflows t0 once
    expect(timers.counter[1]).toBe(1);
    // Cascade chain doesn't consume t0's spare ticks — t0 reload was 0xFFFE
    // so after overflow it lands at 0xFFFE + (3 ticks - overflow) = 0xFFFF
    expect(timers.counter[0]).toBe(0xFFFF);
  });

  it('IRQ on overflow raises IRQ_TIMER0 when ctrl bit 6 (IRQ-enable) is set', () => {
    setReload(timers, 0, 0xFFFF);
    enable(timers, 0, 0x80 | 0x40);     // enable + IRQ on overflow
    timers.step(1);                     // 1 tick → overflow
    expect(irq.if_ & IRQ_TIMER0).toBe(IRQ_TIMER0);
  });

  it('IRQ on overflow stays cleared when ctrl bit 6 is not set', () => {
    setReload(timers, 0, 0xFFFF);
    enable(timers, 0, 0x80);            // no IRQ
    timers.step(1);
    expect(irq.if_ & IRQ_TIMER0).toBe(0);
  });

  it('disabling a timer mid-flight preserves the counter at its current value', () => {
    setReload(timers, 0, 0x1000);
    enable(timers, 0, 0x80);            // /1
    timers.step(50);
    const beforeDisable = timers.counter[0];
    expect(beforeDisable).toBe(0x1000 + 50);
    enable(timers, 0, 0);               // clear enable bit
    timers.step(1000);                  // no further advance
    expect(timers.counter[0]).toBe(beforeDisable);
  });

  it('reload is latched on enable rising edge, not on every overflow change', () => {
    setReload(timers, 0, 0x100);
    enable(timers, 0, 0x80);            // enable → counter = reload = 0x100
    expect(timers.counter[0]).toBe(0x100);
    // Now CHANGE reload while the timer is running. The new reload value
    // is what gets latched on the next overflow — counter is unaffected
    // until then.
    setReload(timers, 0, 0xFF00);
    timers.step(0x10);                  // small tick advances counter only
    expect(timers.counter[0]).toBe(0x110);
    // Disabling and re-enabling re-latches to the new reload.
    enable(timers, 0, 0);
    enable(timers, 0, 0x80);
    expect(timers.counter[0]).toBe(0xFF00);
  });

  it('cascade chain propagates IRQs through all enabled timers', () => {
    // Set timers 1..3 to a high reload so they only need a few cascade
    // ticks to overflow.
    setReload(timers, 0, 0xFFFF);
    enable(timers, 0, 0x80);            // /1
    setReload(timers, 1, 0xFFF0);
    enable(timers, 1, 0x80 | 0x04 | 0x40);  // cascade + IRQ
    setReload(timers, 2, 0xFFFE);
    enable(timers, 2, 0x80 | 0x04);         // cascade, no IRQ
    setReload(timers, 3, 0xFFFE);
    enable(timers, 3, 0x80 | 0x04 | 0x40);  // cascade + IRQ
    // 16 cycles → 16 t0 overflows → t1 += 16 → t1 overflows once → IRQ_T1.
    timers.step(16);
    expect(irq.if_ & IRQ_TIMER1).toBe(IRQ_TIMER1);
    // t2 / t3 didn't accumulate enough cascade pulses (t2 needed 2).
    expect(irq.if_ & IRQ_TIMER3).toBe(0);
    // t0 didn't have IRQ enabled.
    expect(irq.if_ & IRQ_TIMER0).toBe(0);
  });
});
