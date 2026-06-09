import { describe, it, expect, beforeEach } from 'vitest';
import { Ipc } from '../io/ipc';
import { Irq, IRQ_IPC_FIFO_NOT_EMPTY, IRQ_IPC_FIFO_EMPTY, IRQ_IPC_SYNC } from '../io/irq';

describe('IPC SYNC', () => {
  let irq9: Irq, irq7: Irq, ipc: Ipc;
  beforeEach(() => {
    irq9 = new Irq();
    irq7 = new Irq();
    ipc = new Ipc(irq9, irq7);
  });

  it('writeSync stores OUT nibble; readSync returns remote OUT + own OUT', () => {
    // ARM9 writes 0x500 (OUT=5).
    ipc.writeSync(true, 0x500);
    expect(ipc.sync9Out).toBe(5);
    // ARM7's view: remote OUT (ARM9=5) in low nibble, own OUT (ARM7=0) in bits 8..11.
    expect(ipc.readSync(false) & 0x0F).toBe(5);
  });

  it('bit-13 strobe raises IRQ_IPC_SYNC on the remote when their rxIrqEn is on', () => {
    ipc.writeSync(false, 0x4000);              // ARM7 sets rxIrqEn = 1
    ipc.writeSync(true, 0x2000);               // ARM9 strobes bit 13
    expect((irq7.if_ & IRQ_IPC_SYNC) >>> 0).toBe(IRQ_IPC_SYNC);
  });

  it('OUT-nibble change also raises remote IRQ_IPC_SYNC (helps polling-only games)', () => {
    ipc.writeSync(true, 0x4000);               // ARM9 sets rxIrqEn = 1
    irq9.if_ = 0;
    ipc.writeSync(false, 0x700);               // ARM7's OUT changed 0 → 7
    expect((irq9.if_ & IRQ_IPC_SYNC) >>> 0).toBe(IRQ_IPC_SYNC);
  });
});

describe('IPC FIFO', () => {
  const ENABLE_BIT = 1 << 15;
  const RECV_NOT_EMPTY_IRQ_EN = 1 << 10;
  const SEND_EMPTY_IRQ_EN = 1 << 2;

  let irq9: Irq, irq7: Irq, ipc: Ipc;
  beforeEach(() => {
    irq9 = new Irq();
    irq7 = new Irq();
    ipc = new Ipc(irq9, irq7);
    ipc.writeCnt(true, ENABLE_BIT);
    ipc.writeCnt(false, ENABLE_BIT);
  });

  it('round-trip: ARM9 writes, ARM7 reads back same value', () => {
    ipc.writeSend(true, 0xDEADBEEF);
    expect(ipc.readRecv(false) >>> 0).toBe(0xDEADBEEF);
  });

  it('reading empty FIFO sets the error bit on the reader', () => {
    expect(ipc.error7).toBe(false);
    ipc.readRecv(false);
    expect(ipc.error7).toBe(true);
  });

  it('recv-not-empty IRQ fires when receiver enables it AND queue transitions empty → non-empty', () => {
    // ARM7 enables recv-not-empty IRQ.
    ipc.writeCnt(false, ENABLE_BIT | RECV_NOT_EMPTY_IRQ_EN);
    irq7.if_ = 0;
    ipc.writeSend(true, 0x42);
    expect((irq7.if_ & IRQ_IPC_FIFO_NOT_EMPTY) >>> 0).toBe(IRQ_IPC_FIFO_NOT_EMPTY);
  });

  it('recv-not-empty IRQ does NOT fire on the second push (queue stays non-empty)', () => {
    ipc.writeCnt(false, ENABLE_BIT | RECV_NOT_EMPTY_IRQ_EN);
    ipc.writeSend(true, 0x42);
    irq7.if_ = 0;
    ipc.writeSend(true, 0x43);   // queue was already non-empty
    expect(irq7.if_ & IRQ_IPC_FIFO_NOT_EMPTY).toBe(0);
  });

  it('send-empty IRQ fires when sender enables it AND consumer drains the queue', () => {
    // ARM7 enables send-empty IRQ. ARM7 sends one word, ARM9 reads it,
    // ARM7 should now get an IRQ.
    ipc.writeCnt(false, ENABLE_BIT | SEND_EMPTY_IRQ_EN);
    ipc.writeSend(false, 0x11);
    irq7.if_ = 0;
    ipc.readRecv(true);
    expect((irq7.if_ & IRQ_IPC_FIFO_EMPTY) >>> 0).toBe(IRQ_IPC_FIFO_EMPTY);
  });

  it('SEND CLEAR bit (bit 3) flushes the send fifo', () => {
    ipc.writeSend(true, 0xAA);
    ipc.writeSend(true, 0xBB);
    expect(ipc.q9to7.size).toBe(2);
    ipc.writeCnt(true, ENABLE_BIT | (1 << 3));   // CLEAR
    expect(ipc.q9to7.size).toBe(0);
  });

  it('full FIFO sets error on writer; the 17th push is dropped', () => {
    for (let i = 0; i < 16; i++) ipc.writeSend(true, i);
    expect(ipc.q9to7.size).toBe(16);
    expect(ipc.error9).toBe(false);
    ipc.writeSend(true, 99);
    expect(ipc.error9).toBe(true);
    expect(ipc.q9to7.size).toBe(16);             // still 16, didn't grow
  });
});
