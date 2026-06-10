// Focused tests for the IPCSYNC IRQ-delivery path and the matching
// halt-wake behaviour in Cpu.step(). Verifies:
//   1. An IPC_SYNC IRQ raised on the remote side is recorded in IF
//      regardless of the remote's IME or CPSR.I.
//   2. A CPU halted with IME=0 wakes when an enabled IRQ comes in
//      (real DS hardware lifts halt on (IE & IF) != 0 even with IME=0).
//   3. The Irq.wakePending flag tracks (ie & if_) correctly and is
//      independent of ime.

import { describe, it, expect, beforeEach } from 'vitest';
import { Ipc } from '../io/ipc';
import { Irq, IRQ_IPC_SYNC } from '../io/irq';
import { Cpu } from '../cpu/cpu';
import type { ArmBus } from '../cpu/bus';

// Minimal stub bus — the halt-wake test never executes instructions, so
// none of the read/write paths get hit. Returning 0 is fine if they do.
function makeStubBus(): ArmBus {
  return {
    read8:  () => 0,
    read16: () => 0,
    read32: () => 0,
    write8:  () => {},
    write16: () => {},
    write32: () => {},
  } as ArmBus;
}

describe('IPC SYNC IRQ delivery', () => {
  let irq9: Irq, irq7: Irq, ipc: Ipc;
  beforeEach(() => {
    irq9 = new Irq();
    irq7 = new Irq();
    ipc = new Ipc(irq9, irq7);
  });

  it('raises remote IRQ_IPC_SYNC on local nibble change (no bit-13 strobe)', () => {
    // ARM7 enables receive-side IRQ. No bit 13 strobe in any write.
    ipc.writeSync(false, 0x4000);
    irq7.if_ = 0;
    irq7.recache();
    ipc.writeSync(true, 0x0300);
    expect(irq7.if_ & IRQ_IPC_SYNC).toBe(IRQ_IPC_SYNC);
  });

  it('does NOT raise remote IRQ when remote rxIrqEn is off', () => {
    // ARM7 leaves rxIrqEn at 0.
    irq7.if_ = 0;
    irq7.recache();
    ipc.writeSync(true, 0x2700);     // strobe bit 13 AND change nibble
    expect(irq7.if_ & IRQ_IPC_SYNC).toBe(0);
  });

  it('recache populates wakePending = (ie & if_), independent of IME', () => {
    irq7.ime = false;
    irq7.ie = IRQ_IPC_SYNC;
    irq7.if_ = 0;
    irq7.recache();
    expect(irq7.cachedPending).toBe(false);
    expect(irq7.wakePending).toBe(false);
    irq7.raise(IRQ_IPC_SYNC);
    expect(irq7.cachedPending).toBe(false);      // gated by IME=0
    expect(irq7.wakePending).toBe(true);         // wake fires anyway
  });

  it('SYNC IRQ delivered to remote raises wakePending regardless of remote IME', () => {
    // Receiving side (ARM7) has IPC SYNC enabled in IE, IME=0, rxIrqEn=1.
    irq7.ime = false;
    irq7.ie = IRQ_IPC_SYNC;
    irq7.recache();
    ipc.writeSync(false, 0x4000);    // ARM7 sets rxIrqEn (and nibble=0)
    irq7.if_ = 0;
    irq7.recache();
    // ARM9 strobes the SYNC IRQ. Receiver's IME=0 so cachedPending stays
    // false (IRQ won't be TAKEN), but wakePending must go true so a
    // halted ARM7 can resume.
    ipc.writeSync(true, 0x2000);
    expect(irq7.if_ & IRQ_IPC_SYNC).toBe(IRQ_IPC_SYNC);
    expect(irq7.cachedPending).toBe(false);
    expect(irq7.wakePending).toBe(true);
  });
});

describe('CPU halt-wake on SYNC IRQ with IME=0', () => {
  it('CPU lifts halt when wakeLine goes high even with IME=0', () => {
    const cpu = new Cpu(makeStubBus(), false);
    cpu.state.halted = true;
    cpu.irqLine = false;
    cpu.wakeLine = false;
    // Step a halted CPU with no wake signal — stays halted.
    cpu.step();
    expect(cpu.state.halted).toBe(true);
    // Now an IPC SYNC IRQ raises (ie & if_) but IME stays 0, so the
    // emulator forwards wakeLine=true while irqLine=false.
    cpu.wakeLine = true;
    cpu.step();
    expect(cpu.state.halted).toBe(false);
  });

  it('CPU stays halted when neither wakeLine nor irqLine are set', () => {
    const cpu = new Cpu(makeStubBus(), true);
    cpu.state.halted = true;
    for (let i = 0; i < 8; i++) cpu.step();
    expect(cpu.state.halted).toBe(true);
  });

  it('end-to-end: ARM9 nibble write unhalts ARM7 with IME=0', () => {
    const irq9 = new Irq();
    const irq7 = new Irq();
    const ipc = new Ipc(irq9, irq7);
    const cpu7 = new Cpu(makeStubBus(), false);

    // ARM7 mirrors the SM64DS-style setup: IPC_SYNC enabled in IE,
    // rxIrqEn set, IME=0, halted (e.g. via SWI 0x06 idle).
    irq7.ie = IRQ_IPC_SYNC;
    irq7.ime = false;
    irq7.recache();
    ipc.writeSync(false, 0x4000);  // ARM7 turns on rxIrqEn
    cpu7.state.halted = true;
    cpu7.wakeLine = irq7.wakePending;
    cpu7.irqLine  = irq7.cachedPending;
    cpu7.step();
    expect(cpu7.state.halted).toBe(true);

    // ARM9 changes its OUT nibble — that fires SYNC IRQ on ARM7.
    ipc.writeSync(true, 0x0900);
    cpu7.wakeLine = irq7.wakePending;
    cpu7.irqLine  = irq7.cachedPending;
    cpu7.step();
    expect(cpu7.state.halted).toBe(false);
  });
});

describe('BIOS WaitByLoop installs CPU stall cycles', () => {
  // Imported lazily so the IRQ / IPC tests above don't need BiosHle.
  it('SWI 0x03 with R0=N parks the CPU in stallCycles = N*4 (capped)', async () => {
    const { BiosHle } = await import('../bios/hle');
    const irq = new Irq();
    const cpu = new Cpu(makeStubBus(), false);
    const bios = new BiosHle(cpu, irq);
    cpu.bios = bios;
    cpu.state.r[0] = 100;
    const ok = bios.handleSwi(0x03);
    expect(ok).toBe(true);
    expect(cpu.stallCycles).toBe(400);
    // Step through the stall — CPU should not enter halt or take IRQs.
    for (let i = 0; i < 400; i++) cpu.step();
    expect(cpu.stallCycles).toBe(0);
  });

  it('stall cycles cap at 256K so a stuck game can not freeze the host', async () => {
    const { BiosHle } = await import('../bios/hle');
    const irq = new Irq();
    const cpu = new Cpu(makeStubBus(), false);
    const bios = new BiosHle(cpu, irq);
    cpu.bios = bios;
    cpu.state.r[0] = 0xFFFF_FFFF;     // huge
    bios.handleSwi(0x03);
    expect(cpu.stallCycles).toBe(1 << 18);
  });
});
