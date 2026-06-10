// Per-CPU interrupt controller. Each CPU has its own IE/IF/IME — IO
// writes go through here. The bus also touches `cachedPending` when an
// IO write to IE/IF/IME could enable an existing IRQ.

export class Irq {
  ie = 0;        // bitmask of enabled IRQ sources
  if_ = 0;       // bitmask of pending IRQ sources
  ime = false;   // master enable
  // Pre-computed: ime && (ie & if_) — sampled by the CPU on every step.
  cachedPending = false;

  recache(): void {
    this.cachedPending = this.ime && (this.ie & this.if_) !== 0;
  }

  raise(bit: number): void {
    this.if_ = (this.if_ | bit) >>> 0;
    this.recache();
  }

  // Writes to IF have ack semantics — a 1 bit clears the bit.
  ackIf(value: number): void {
    this.if_ = (this.if_ & ~value) >>> 0;
    this.recache();
  }

  setIe(value: number): void { this.ie = value >>> 0; this.recache(); }
  setIme(value: number): void { this.ime = (value & 1) !== 0; this.recache(); }
}

// IRQ bit positions (shared between ARM9 and ARM7).
export const IRQ_VBLANK   = 1 << 0;
export const IRQ_HBLANK   = 1 << 1;
export const IRQ_VCOUNT   = 1 << 2;
export const IRQ_TIMER0   = 1 << 3;
export const IRQ_TIMER1   = 1 << 4;
export const IRQ_TIMER2   = 1 << 5;
export const IRQ_TIMER3   = 1 << 6;
export const IRQ_DMA0     = 1 << 8;
export const IRQ_DMA1     = 1 << 9;
export const IRQ_DMA2     = 1 << 10;
export const IRQ_DMA3     = 1 << 11;
export const IRQ_KEYPAD   = 1 << 12;
export const IRQ_IPC_SYNC = 1 << 16;
export const IRQ_IPC_FIFO_EMPTY = 1 << 17;
export const IRQ_IPC_FIFO_NOT_EMPTY = 1 << 18;
export const IRQ_CART     = 1 << 19;
