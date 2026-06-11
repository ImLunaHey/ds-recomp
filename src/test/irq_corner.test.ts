// Corner-case tests for the per-CPU IRQ controller. The basic raise +
// ack path is exercised indirectly across many tests; here we focus on
// the cached-pending invariants and edge cases of write-1-to-clear.

import { describe, it, expect, beforeEach } from 'vitest';
import { Irq, IRQ_VBLANK, IRQ_HBLANK, IRQ_VCOUNT, IRQ_TIMER0 } from '../io/irq';

describe('Irq corner cases', () => {
  let irq: Irq;
  beforeEach(() => { irq = new Irq(); });

  it('ackIf is write-1-to-clear (0x5 acks bits 0 and 2)', () => {
    // Pre-populate IF=0xF (4 lower bits).
    irq.raise(0xF);
    expect(irq.if_).toBe(0xF);
    // Ack bits 0 (0x1) and 2 (0x4) — should leave bits 1 and 3 (= 0xA).
    irq.ackIf(0x5);
    expect(irq.if_).toBe(0xA);
  });

  it('cachedPending recomputed after IE / IF / IME change', () => {
    irq.setIme(1);
    expect(irq.cachedPending).toBe(false);
    irq.raise(IRQ_VBLANK);
    expect(irq.cachedPending).toBe(false);   // IE not set yet
    irq.setIe(IRQ_VBLANK);
    expect(irq.cachedPending).toBe(true);
    irq.ackIf(IRQ_VBLANK);                    // clear pending
    expect(irq.cachedPending).toBe(false);
  });

  it('IRQ raise with IME=0 sets IF but leaves cachedPending false (wakePending true)', () => {
    irq.setIme(0);
    irq.setIe(IRQ_VBLANK);
    irq.raise(IRQ_VBLANK);
    expect(irq.if_ & IRQ_VBLANK).toBe(IRQ_VBLANK);
    expect(irq.cachedPending).toBe(false);
    // wakePending is true so a HALT exits even with IME=0.
    expect(irq.wakePending).toBe(true);
  });

  it('raise then ack toggles cachedPending', () => {
    irq.setIme(1);
    irq.setIe(IRQ_VBLANK | IRQ_HBLANK);
    irq.raise(IRQ_VBLANK);
    expect(irq.cachedPending).toBe(true);
    irq.ackIf(IRQ_VBLANK);
    expect(irq.cachedPending).toBe(false);
  });

  it('repeated raise of the same bit is idempotent (no double-fire on IF)', () => {
    irq.setIme(1);
    irq.setIe(IRQ_VBLANK);
    irq.raise(IRQ_VBLANK);
    const after1 = irq.if_;
    irq.raise(IRQ_VBLANK);
    irq.raise(IRQ_VBLANK);
    // The bit is OR'd in — multiple raises don't accumulate beyond
    // setting the bit once.
    expect(irq.if_).toBe(after1);
  });

  it('raise on bit not in IE does NOT set cachedPending but still sets IF', () => {
    irq.setIme(1);
    irq.setIe(IRQ_VBLANK);                   // VCOUNT not enabled
    irq.raise(IRQ_VCOUNT);
    expect(irq.if_ & IRQ_VCOUNT).toBe(IRQ_VCOUNT);
    expect(irq.cachedPending).toBe(false);
    // Then enabling VCOUNT after the fact lights cachedPending.
    irq.setIe(IRQ_VBLANK | IRQ_VCOUNT);
    expect(irq.cachedPending).toBe(true);
  });

  it('multiple distinct raised bits are OR\'d into IF', () => {
    irq.setIme(1);
    irq.setIe(IRQ_VBLANK | IRQ_HBLANK | IRQ_TIMER0);
    irq.raise(IRQ_VBLANK);
    irq.raise(IRQ_HBLANK);
    irq.raise(IRQ_TIMER0);
    expect(irq.if_).toBe(IRQ_VBLANK | IRQ_HBLANK | IRQ_TIMER0);
    expect(irq.cachedPending).toBe(true);
    // Acking just one leaves the others pending.
    irq.ackIf(IRQ_HBLANK);
    expect(irq.if_).toBe(IRQ_VBLANK | IRQ_TIMER0);
    expect(irq.cachedPending).toBe(true);
  });
});
