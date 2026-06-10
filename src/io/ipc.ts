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
//
// SYSTEM tag (0x00) is intentionally NOT in this table. A previous
// version stripped bit 5 of the low byte for 0x00 replies that had a
// nonzero command-class byte, on the theory that it was a stale busy
// indicator like the SND tag's. That broke Nintendogs: ARM9 sends
// 0x00040005 to ARM7, ARM7 replies 0x00040025 (bit 5 set in the low
// byte) to signal completion — stripping bit 5 made the reply look
// like an echo of the original command, so ARM9's PXI dispatcher
// ignored it and the dependent "wait for flag clear" code spun forever
// (the flag at 0x02155b64 is set by ARM9 just before the send and is
// cleared by the FIFO RECV-NOT-EMPTY IRQ handler when the real
// completion arrives). The Pokemon Platinum / Tetris DS / NSMB
// captures that motivated the 0x00 entry never actually hit it — their
// 0x00-tag traffic puts bit 5 in the upper-payload byte (e.g. Pokemon
// Platinum's 0x00240005), not the low byte where the mask is applied.
// The keys are the literal top byte, not a 6-bit "tag" — NitroSDK
// formats are inconsistent across SDK versions, and the high-byte view
// is what matches our captures.
const PXI_REPLY_BUSY_BITS: Record<number, number> = {
  0xC0: 0x00200000,
  0x80: 0x00000020,
  0x40: 0x00000020,
};

export function normalizePxiReply(value: number): number {
  const tag = (value >>> 24) & 0xFF;
  const mask = PXI_REPLY_BUSY_BITS[tag];
  if (mask === undefined) return value >>> 0;
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

  // When true, ARM9→ARM7 PXI commands trigger synthesized "command
  // complete" replies on the q7to9 queue (see `processArm9Command`).
  // Opt-in because the existing FIFO round-trip tests assume no
  // unsolicited traffic — they enable the FIFO, push a word ARM9→ARM7,
  // and read it back on the ARM7 side without expecting q7to9 to have
  // grown. Retail boots flip this on via the emulator wiring; unit
  // tests for the stub server flip it on explicitly.
  pxiStubServerEnabled = false;

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
    // The same pattern shows up on the WM (tag 0x40) and MIC (tag 0x80)
    // tags during Pokemon Platinum's wireless / microphone init. We
    // normalize ARM7→ARM9 words by tag-byte, stripping the documented
    // "NG / busy" bit so ARM9 sees a clean completion. The SYSTEM tag
    // (0x00) is deliberately not normalized — see the comment on
    // PXI_REPLY_BUSY_BITS.
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
    // Stub PXI server: after the ARM9→ARM7 word is queued, synthesize
    // any "command complete" reply ARM7's NitroSDK PXI server would
    // normally produce. Gated by an explicit opt-in flag so unit tests
    // that don't expect unsolicited q7to9 traffic stay clean.
    if (isArm9 && !synthetic && this.pxiStubServerEnabled) {
      this.processArm9Command(value >>> 0);
    }
  }

  // ---- PXI stub server ----
  // NitroSDK's PXI subsystems each run a server loop on ARM7 that
  // consumes commands from q9to7 and pushes "command complete" replies
  // back on q7to9. We don't model those servers — we just queue the
  // single reply word the SDK's command-dispatcher needs to see in
  // order to mark its outstanding request as finished and wake the
  // ARM9-side caller (typically a thread blocked on OS_SleepThread()
  // until the reply IRQ runs the per-tag callback).
  //
  // Patterns identified from boot traces of retail games:
  //
  //   0xC0 — SND / SNDi. Pokemon Platinum batches four SND commands
  //     per VBlank (0xC0080004, 0x80088084, 0x00470E84, 0x40A00004 in
  //     the same frame). ARM7 normally echoes each command back with a
  //     bit set to indicate completion. We mirror the command word
  //     unchanged — the existing `normalizePxiReply` path strips
  //     bit 21 anyway, so the receiver sees a clean "done" word.
  //
  //   0x80 — MIC. Same shape as SND: echo back, normalize strips the
  //     busy bit.
  //
  //   0x40 — WM (wireless manager) commands sent from the ARM9 side
  //     during the early SDK init.
  //
  //   0x05 — WM init handshake. Meteos sends a single 0x0501504D word
  //     and sits in a poll waiting for ARM7's reply. The reply byte
  //     pattern observed on real hardware is the command word with the
  //     low bit set (a "command accepted" ack).
  //
  //   0x00 — SYSTEM tag. Nintendogs sends 0x00040005 and expects
  //     0x00040025 back (bit 5 of the low byte = completion). We don't
  //     blindly echo for SYSTEM because the SYSTEM tag covers a wide
  //     command space — we match the specific shape we know about.
  private processArm9Command(value: number): void {
    const tag = (value >>> 24) & 0xFF;
    switch (tag) {
      case 0xC0:
      case 0x80:
      case 0x40:
        // Echo the command back. normalizePxiReply on the writeSend
        // path strips the documented busy bit for tags 0xC0/0x80/0x40,
        // so the receiver sees a completion-shaped reply without us
        // having to know the exact "OK" bit for each subsystem.
        this.queueArm7Reply(value);
        return;
      case 0x05:
        // WM init ack — low bit set on the echoed command word.
        this.queueArm7Reply((value | 0x01) >>> 0);
        return;
      case 0x00:
        // Only synthesize for the Nintendogs-shaped SYSTEM command
        // (0x000400xx — "init service 0x04"). For these, real ARM7
        // sets bit 5 of the low byte to signal completion. Other
        // SYSTEM-tag commands carry their own protocol and we leave
        // them for the real handshake (or other heuristics) to
        // resolve.
        if ((value & 0x00FF0000) === 0x00040000) {
          this.queueArm7Reply((value | 0x00000020) >>> 0);
        }
        return;
      default:
        return;
    }
  }

  // Push a synthetic ARM7→ARM9 reply word. Goes through writeSend with
  // `synthetic=true` so it doesn't flip the realFifoTrafficSeen /
  // framesSinceLastSend bookkeeping — those track real game traffic so
  // the PPU deadlock heartbeat stays accurate. The normal writeSend
  // path also handles the empty→non-empty IRQ on ARM9 and the
  // PXI reply normalization, so we don't need to duplicate either.
  private queueArm7Reply(value: number): void {
    if (!this.enable7) return;
    this.writeSend(false, value >>> 0, true);
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
