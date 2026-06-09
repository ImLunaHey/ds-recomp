// Inter-Processor Communication. Two pieces of hardware:
//
//   IPCSYNC (0x04000180, halfword): a 4-bit "I sent" / "I see" pair of
//   nibbles each CPU can poke. Bit 13 is a write-strobe — when set, it
//   raises IRQ_IPC_SYNC on the *remote* CPU if the remote has bit 14
//   set in *its* IPCSYNC.
//
//   IPC FIFO (CNT at 0x184, SEND at 0x188, RECV at 0x04100000): two
//   one-way 16-entry word queues. CPU A writing SEND enqueues a word
//   onto a queue that becomes CPU B's RECV. Empty/full status and per-
//   transition IRQs are reported in the CNT halfword.
//
// We funnel both through one `Ipc` instance attached to the emulator,
// so the two IoBuses share state.

import { Irq, IRQ_IPC_SYNC, IRQ_IPC_FIFO_EMPTY, IRQ_IPC_FIFO_NOT_EMPTY } from './irq';

const FIFO_CAPACITY = 16;

const CNT_SEND_EMPTY        = 0x0001;
const CNT_SEND_FULL         = 0x0002;
const CNT_SEND_EMPTY_IRQ_EN = 0x0004;
const CNT_SEND_CLEAR        = 0x0008;   // write-only
const CNT_RECV_EMPTY        = 0x0100;
const CNT_RECV_FULL         = 0x0200;
const CNT_RECV_NOT_EMPTY_IRQ_EN = 0x0400;
const CNT_ERROR             = 0x4000;
const CNT_ENABLE            = 0x8000;

class Queue {
  buf = new Uint32Array(FIFO_CAPACITY);
  head = 0;
  tail = 0;
  size = 0;
  lastRead = 0;     // sticky on empty-read (real HW returns last value).
  push(v: number): boolean {
    if (this.size >= FIFO_CAPACITY) return false;
    this.buf[this.tail] = v >>> 0;
    this.tail = (this.tail + 1) % FIFO_CAPACITY;
    this.size++;
    return true;
  }
  pop(): number | null {
    if (this.size === 0) return null;
    const v = this.buf[this.head];
    this.head = (this.head + 1) % FIFO_CAPACITY;
    this.size--;
    this.lastRead = v;
    return v;
  }
  clear(): void { this.head = this.tail = this.size = 0; }
}

export class Ipc {
  irq9: Irq;
  irq7: Irq;

  // IPCSYNC: per-CPU 4-bit OUT nibble + the receive-IRQ-enable bit 14.
  sync9Out = 0;
  sync9RxIrqEn = false;
  sync7Out = 0;
  sync7RxIrqEn = false;

  // FIFO: q9to7 fed by ARM9's SEND, consumed by ARM7's RECV. Mirror in
  // the other direction. Each CPU sees its own perspective in CNT.
  q9to7 = new Queue();
  q7to9 = new Queue();

  // Per-CPU CNT control bits (the ones we actually write back to).
  enable9 = false;
  enable7 = false;
  sendEmptyIrqEn9 = false;
  sendEmptyIrqEn7 = false;
  recvNotEmptyIrqEn9 = false;
  recvNotEmptyIrqEn7 = false;
  error9 = false;
  error7 = false;
  // Set true the moment EITHER CPU has ever performed a real FIFO
  // SEND. Used by the PPU's VBlank heartbeat to decide whether to
  // synthesize a beacon (only when the game itself hasn't established
  // IPC FIFO traffic).
  realFifoTrafficSeen = false;

  constructor(irq9: Irq, irq7: Irq) {
    this.irq9 = irq9;
    this.irq7 = irq7;
  }

  // ---- IPCSYNC ----
  readSync(isArm9: boolean): number {
    const remoteOut = isArm9 ? this.sync7Out : this.sync9Out;
    const ourOut    = isArm9 ? this.sync9Out : this.sync7Out;
    const ourRxEn   = isArm9 ? this.sync9RxIrqEn : this.sync7RxIrqEn;
    return (remoteOut & 0x0F) | ((ourOut & 0x0F) << 8) | (ourRxEn ? 0x4000 : 0);
  }
  writeSync(isArm9: boolean, value: number): void {
    const out = (value >>> 8) & 0x0F;
    const sendIrq = (value & 0x2000) !== 0;
    const rxIrqEn = (value & 0x4000) !== 0;
    const oldOut = isArm9 ? this.sync9Out : this.sync7Out;
    if (isArm9) { this.sync9Out = out; this.sync9RxIrqEn = rxIrqEn; }
    else        { this.sync7Out = out; this.sync7RxIrqEn = rxIrqEn; }
    // Strobe — bit 13 explicitly requests a remote IRQ.
    const valueChanged = out !== oldOut;
    if (sendIrq || valueChanged) {
      // We extend the spec slightly and *also* fire IRQ_IPC_SYNC on any
      // OUT-nibble change, gated by the remote's rxIrqEn. Pokemon games
      // poll IPCSYNC without ever strobing bit 13, expecting the bus to
      // wake them on value change — that's the no$gba/melonDS-observed
      // behavior, and without it the early handshake deadlocks.
      if (isArm9 && this.sync7RxIrqEn) this.irq7.raise(IRQ_IPC_SYNC);
      if (!isArm9 && this.sync9RxIrqEn) this.irq9.raise(IRQ_IPC_SYNC);
    }
  }

  // ---- IPC FIFO control ----
  readCnt(isArm9: boolean): number {
    const sendQ = isArm9 ? this.q9to7 : this.q7to9;
    const recvQ = isArm9 ? this.q7to9 : this.q9to7;
    let v = 0;
    if (sendQ.size === 0)            v |= CNT_SEND_EMPTY;
    if (sendQ.size >= FIFO_CAPACITY) v |= CNT_SEND_FULL;
    if (recvQ.size === 0)            v |= CNT_RECV_EMPTY;
    if (recvQ.size >= FIFO_CAPACITY) v |= CNT_RECV_FULL;
    if (isArm9) {
      if (this.sendEmptyIrqEn9)     v |= CNT_SEND_EMPTY_IRQ_EN;
      if (this.recvNotEmptyIrqEn9)  v |= CNT_RECV_NOT_EMPTY_IRQ_EN;
      if (this.error9)              v |= CNT_ERROR;
      if (this.enable9)             v |= CNT_ENABLE;
    } else {
      if (this.sendEmptyIrqEn7)     v |= CNT_SEND_EMPTY_IRQ_EN;
      if (this.recvNotEmptyIrqEn7)  v |= CNT_RECV_NOT_EMPTY_IRQ_EN;
      if (this.error7)              v |= CNT_ERROR;
      if (this.enable7)             v |= CNT_ENABLE;
    }
    return v >>> 0;
  }
  writeCnt(isArm9: boolean, value: number): void {
    const wantSendEmpty = (value & CNT_SEND_EMPTY_IRQ_EN) !== 0;
    const wantRecvNE = (value & CNT_RECV_NOT_EMPTY_IRQ_EN) !== 0;
    const wantEnable = (value & CNT_ENABLE) !== 0;
    const clearSend = (value & CNT_SEND_CLEAR) !== 0;
    const ackError = (value & CNT_ERROR) !== 0;
    if (isArm9) {
      this.sendEmptyIrqEn9 = wantSendEmpty;
      this.recvNotEmptyIrqEn9 = wantRecvNE;
      this.enable9 = wantEnable;
      if (clearSend) this.q9to7.clear();
      if (ackError) this.error9 = false;
    } else {
      this.sendEmptyIrqEn7 = wantSendEmpty;
      this.recvNotEmptyIrqEn7 = wantRecvNE;
      this.enable7 = wantEnable;
      if (clearSend) this.q7to9.clear();
      if (ackError) this.error7 = false;
    }
  }

  // ---- FIFO SEND ----
  // `synthetic=true` means this is a PPU-injected heartbeat and must not
  // flip the realFifoTrafficSeen flag.
  writeSend(isArm9: boolean, value: number, synthetic = false): void {
    const enable = isArm9 ? this.enable9 : this.enable7;
    if (!enable) return;
    if (!synthetic) this.realFifoTrafficSeen = true;
    const q = isArm9 ? this.q9to7 : this.q7to9;
    const remoteRecvNotEmptyEn = isArm9 ? this.recvNotEmptyIrqEn7 : this.recvNotEmptyIrqEn9;
    const remoteIrq = isArm9 ? this.irq7 : this.irq9;
    const wasEmpty = q.size === 0;
    const pushed = q.push(value);
    if (!pushed) {
      // Send fifo full — set error flag for the sender.
      if (isArm9) this.error9 = true; else this.error7 = true;
      return;
    }
    if (wasEmpty && remoteRecvNotEmptyEn) {
      remoteIrq.raise(IRQ_IPC_FIFO_NOT_EMPTY);
    }
  }

  // ---- FIFO RECV ----
  readRecv(isArm9: boolean): number {
    const enable = isArm9 ? this.enable9 : this.enable7;
    const q = isArm9 ? this.q7to9 : this.q9to7;
    if (!enable) return q.lastRead;
    const before = q.size;
    const v = q.pop();
    if (v === null) {
      // Empty-read error on the consumer.
      if (isArm9) this.error9 = true; else this.error7 = true;
      return q.lastRead;
    }
    // Sender's send-empty IRQ fires when their send-fifo becomes empty.
    if (before > 0 && q.size === 0) {
      const senderEmptyEn = isArm9 ? this.sendEmptyIrqEn7 : this.sendEmptyIrqEn9;
      const senderIrq = isArm9 ? this.irq7 : this.irq9;
      if (senderEmptyEn) senderIrq.raise(IRQ_IPC_FIFO_EMPTY);
    }
    return v >>> 0;
  }
}
