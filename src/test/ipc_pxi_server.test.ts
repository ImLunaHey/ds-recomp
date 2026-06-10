// PXI stub server tests. NitroSDK retail games (Meteos, Pokemon
// Platinum, Nintendogs, ...) issue ARM9→ARM7 PXI commands and block on
// the "command complete" reply that the real ARM7-side subsystem code
// would push back. We don't run those subsystems, so the Ipc instance
// synthesizes per-tag replies when `pxiStubServerEnabled` is on.
//
// The Ipc instance is opt-in: existing FIFO round-trip tests expect
// q7to9 to stay empty after an ARM9 push, so the stub server defaults
// to off.

import { describe, it, expect, beforeEach } from 'vitest';
import { Ipc } from '../io/ipc';
import { Irq, IRQ_IPC_FIFO_NOT_EMPTY } from '../io/irq';

const ENABLE_BIT = 1 << 15;
const RECV_NOT_EMPTY_IRQ_EN = 1 << 10;

describe('IPC PXI stub server', () => {
  let irq9: Irq, irq7: Irq, ipc: Ipc;
  beforeEach(() => {
    irq9 = new Irq();
    irq7 = new Irq();
    ipc = new Ipc(irq9, irq7);
    ipc.writeCnt(true, ENABLE_BIT);
    ipc.writeCnt(false, ENABLE_BIT);
    ipc.pxiStubServerEnabled = true;
  });

  it('opts out by default — ARM9 send leaves q7to9 empty', () => {
    const fresh = new Ipc(new Irq(), new Irq());
    fresh.writeCnt(true, ENABLE_BIT);
    fresh.writeCnt(false, ENABLE_BIT);
    // Default state — stub server off.
    expect(fresh.pxiStubServerEnabled).toBe(false);
    fresh.writeSend(true, 0xC0080004);
    expect(fresh.q7to9.size).toBe(0);
  });

  it('tag 0x05 (WM init) queues a "command complete" reply with low bit set', () => {
    // Meteos: ARM9 sends 0x0501504D; ARM7 should ack with low bit set.
    ipc.writeSend(true, 0x0501504D);
    expect(ipc.q7to9.size).toBe(1);
    expect(ipc.readRecv(true) >>> 0).toBe(0x0501504D | 0x01);
  });

  it('tag 0xC0 (SND) queues a reply whose bit 21 is NOT set after normalize', () => {
    // Pokemon Platinum SND command. The stub echoes the command, the
    // outgoing-normalize path strips bit 21, so ARM9 sees a "done" word.
    ipc.writeSend(true, 0xC0280004);
    expect(ipc.q7to9.size).toBe(1);
    const reply = ipc.readRecv(true) >>> 0;
    expect(reply & 0x00200000).toBe(0);
    expect(reply).toBe(0xC0080004);
  });

  it('tag 0x80 (MIC) queues a reply whose bit 5 is NOT set after normalize', () => {
    ipc.writeSend(true, 0x80088024);
    expect(ipc.q7to9.size).toBe(1);
    const reply = ipc.readRecv(true) >>> 0;
    expect(reply & 0x00000020).toBe(0);
    expect(reply).toBe(0x80088004);
  });

  it('tag 0x40 (WM) queues a reply whose bit 5 is NOT set after normalize', () => {
    ipc.writeSend(true, 0x40A00024);
    expect(ipc.q7to9.size).toBe(1);
    const reply = ipc.readRecv(true) >>> 0;
    expect(reply & 0x00000020).toBe(0);
    expect(reply).toBe(0x40A00004);
  });

  it('SYSTEM-tag 0x000400xx (Nintendogs ack) queues a bit-5-set reply', () => {
    // Nintendogs: ARM9 0x00040005, ARM7 reply 0x00040025 (bit 5 set).
    // SYSTEM tag is intentionally passthrough in normalizePxiReply, so
    // the bit-5 difference is preserved on the wire.
    ipc.writeSend(true, 0x00040005);
    expect(ipc.q7to9.size).toBe(1);
    expect(ipc.readRecv(true) >>> 0).toBe(0x00040025);
  });

  it('other SYSTEM-tag commands are NOT auto-acked (only the 0x000400xx shape)', () => {
    // Pokemon-style 0x00240005 doesn't match the Nintendogs init shape;
    // leave it alone rather than risk an erroneous wake-up.
    ipc.writeSend(true, 0x00240005);
    expect(ipc.q7to9.size).toBe(0);
  });

  it('unknown tag is left alone — no spurious reply', () => {
    ipc.writeSend(true, 0x12345678);
    expect(ipc.q7to9.size).toBe(0);
  });

  it('multiple commands queue multiple replies (Pokemon batched SND/MIC/SYSTEM/WM)', () => {
    // Pokemon Platinum sends four PXI commands per frame.
    ipc.writeSend(true, 0xC0080004);
    ipc.writeSend(true, 0x80088084);
    ipc.writeSend(true, 0x00040005);   // SYSTEM init shape → ack
    ipc.writeSend(true, 0x40A00004);
    expect(ipc.q7to9.size).toBe(4);
    // Read them back in order.
    expect(ipc.readRecv(true) >>> 0).toBe(0xC0080004);
    expect(ipc.readRecv(true) >>> 0).toBe(0x80088084);
    expect(ipc.readRecv(true) >>> 0).toBe(0x00040025);
    expect(ipc.readRecv(true) >>> 0).toBe(0x40A00004);
  });

  it('synthetic replies fire the ARM9 recv-not-empty IRQ on the empty→non-empty transition', () => {
    ipc.writeCnt(true, ENABLE_BIT | RECV_NOT_EMPTY_IRQ_EN);
    irq9.if_ = 0;
    irq9.recache();
    ipc.writeSend(true, 0x0501504D);
    expect((irq9.if_ & IRQ_IPC_FIFO_NOT_EMPTY) >>> 0).toBe(IRQ_IPC_FIFO_NOT_EMPTY);
  });

  it('synthetic replies do NOT flip realFifoTrafficSeen / framesSinceLastSend', () => {
    // The PPU's deadlock heartbeat heuristic must keep working — it
    // only cares about real game traffic, not auto-acks the bus
    // generates. The ARM9 SEND itself counts as real traffic, but the
    // ARM7-side reply must not double-count.
    ipc.realFifoTrafficSeen = false;
    ipc.framesSinceLastSend = 50;
    ipc.writeSend(true, 0xC0080004);
    // The ARM9 send is real (zeroes framesSinceLastSend), but the
    // synthetic reply path must not also push framesSinceLastSend
    // around — verify the counter stayed at the post-ARM9-send value.
    expect(ipc.realFifoTrafficSeen).toBe(true);
    expect(ipc.framesSinceLastSend).toBe(0);
  });

  it('respects ARM7 FIFO enable — stub replies suppressed when ARM7 disabled', () => {
    // If ARM7's FIFO is disabled, the real ARM7 server wouldn't be
    // running either. Skip the stub reply rather than queue traffic
    // the game isn't ready to receive.
    ipc.writeCnt(false, 0);             // disable ARM7 side
    ipc.writeCnt(true, ENABLE_BIT);     // ARM9 still enabled
    ipc.writeSend(true, 0xC0080004);
    expect(ipc.q7to9.size).toBe(0);
  });
});
