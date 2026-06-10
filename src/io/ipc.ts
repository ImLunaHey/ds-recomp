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

// PXI reply-normalization table. Each entry pairs a NitroSDK subsystem
// tag (the high byte of an ARM7→ARM9 PXI word) with the busy / NG bit
// mask we strip on the reply. The masks come from observing real
// retail ROMs (Tetris DS, Pokemon Platinum, Nintendogs) where ARM7's
// stub responses leave those bits set indefinitely, causing ARM9 to
// poll-retry forever. Stripping them lets ARM9 observe a "success"
// completion without us needing to model each subsystem on ARM7.
//
//   0xC0 — SND (SNDi): bit 21 = NG (sound thread not yet initialized).
//   0x80 — MIC / SYSTEM-extended: bit 5 = busy on the early init reply.
//   0x40 — WM (wireless manager): bit 5 = busy on radio init replies.
//   0x00 — SYSTEM: bit 5 = busy on the early system-init reply that
//          Nintendogs hammers tens of thousands of times. The system
//          tag is also used for the periodic ARM7→ARM9 heartbeat tick
//          (e.g. Pokemon Platinum's 0x0000006B counter), where bit 5
//          happens to be a real payload bit we MUST NOT strip — so we
//          gate the 0x00-tag strip on the message having a non-empty
//          upper-payload byte (bits 16..23). That distinguishes a
//          tagged subsystem command from a small numeric tick.
//
// The keys are the literal top byte, not a 6-bit "tag" — NitroSDK
// formats are inconsistent across SDK versions, and the high-byte view
// is what matches our captures.
const PXI_REPLY_BUSY_BITS: Record<number, number> = {
  0xC0: 0x00200000,
  0x80: 0x00000020,
  0x40: 0x00000020,
  0x00: 0x00000020,
};

// Tags that require an extra structural guard before we strip — the
// strip only fires if the value has any bits set in payload bits
// 16..23 (the "command-class" byte for tagged PXI messages).
const PXI_REPLY_TAG_GUARDED: Record<number, true> = {
  0x00: true,
};

export function normalizePxiReply(value: number): number {
  const tag = (value >>> 24) & 0xFF;
  const mask = PXI_REPLY_BUSY_BITS[tag];
  if (mask === undefined) return value >>> 0;
  if (PXI_REPLY_TAG_GUARDED[tag] && ((value & 0x00FF0000) >>> 0) === 0) {
    // Looks like a bare numeric tick (heartbeat / sync counter), not
    // a tagged command. Leave untouched.
    return value >>> 0;
  }
  return (value & ~mask) >>> 0;
}

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
  // Tracks frames since last real FIFO send by either side. Used to
  // detect deadlocked retail games (60+ frames with no IPC) without
  // disturbing test ROMs that ARE doing IPC and just happen to be
  // slow.
  framesSinceLastSend = 0;

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
    if (!synthetic) { this.realFifoTrafficSeen = true; this.framesSinceLastSend = 0; }
    // PXI reply normalization. NitroSDK's command/reply protocol uses
    // the top byte of the 32-bit word as a "subsystem tag", and ARM7's
    // subsystem stubs set busy / NG indicator bits in the reply when
    // they are not initialized or are still processing. Without
    // accurate ARM7-side models for each subsystem, those bits stay
    // set forever and ARM9 retries the command every VBlank IRQ —
    // Tetris DS spends 160+ frames in this loop on SNDi (tag 0xC0).
    //
    // The same pattern shows up across other tags: Nintendogs hammers
    // the SYSTEM tag (0x00) with bit-5 set in every reply, Pokemon
    // Platinum's WM (0x40) / MIC (0x80) replies similarly carry stale
    // busy bits. We normalize ARM7→ARM9 words by tag-byte, stripping
    // the documented "NG / busy" bit so ARM9 sees a clean completion.
    if (!isArm9) value = normalizePxiReply(value);
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
