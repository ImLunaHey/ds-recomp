// NDS WiFi register stubs at ARM7 0x04800000-0x04807FFF (per GBATEK
// §"DS Wireless Communications").
//
// We don't emulate the WiFi link layer or the baseband — there's no
// peer to talk to. The goal here is purely to keep games that probe
// the chip during boot from hanging when they get back nonsense. Real
// chip behavior we mimic:
//
//   - Chip-ID register (0x0480000C) returns 0x1440. Software uses this
//     to identify the Mitsumi/Atheros DS WiFi MAC. A wrong value makes
//     init bail in different (often hang-y) ways.
//   - Writing 0x8001 to W_POWER_STATE (0x04800040) "powers up" the
//     chip; the chip then reports the ready bit (bit 9) so polling
//     loops complete. We snap straight to that state.
//   - Baseband (BB) reg read/write protocol: the host writes BB_CNT
//     (0x04800158) with the BB register address + direction bit; the
//     value to write goes in BB_WRITE (0x0480015A); reads come back
//     via BB_READ (0x0480015C). Unimplemented BB regs read as 0xFF —
//     that's what the real chip's reset state looks like.
//
// Everything else is backed by a 32 KB shadow array so reads return
// whatever was last written (which matches enough real-hardware
// behavior to keep games like Brain Training, Mario Kart DS, Pokemon
// Diamond/Pearl from stalling on probe.

export const WIFI_BASE = 0x04800000;
export const WIFI_END  = 0x04808000;  // exclusive

const W_CHIPID         = 0x0480000C;
const W_MODE_RST       = 0x04800006;
const W_POWER_US       = 0x04800036;  // power-up timer (us)
const W_POWER_DOWN     = 0x0480003C;
const W_POWER_STATE    = 0x04800040;
const W_RXBUF_BEGIN    = 0x04800050;
const W_RXBUF_END      = 0x04800054;
const W_RXBUF_RD_ADDR  = 0x04800058;
const W_TXBUF_WR_ADDR  = 0x04800068;
const W_TXBUF_WR_DATA  = 0x04800070;
const W_BB_CNT         = 0x04800158;
const W_BB_WRITE       = 0x0480015A;
const W_BB_READ        = 0x0480015C;

// W_POWER_STATE bits (per GBATEK):
//   bit 0  : power-down request
//   bit 1  : power-up request (write 1 to bring chip up)
//   bit 9  : "chip is awake / ready" — what games poll for
//   bit 15 : power management enable
const POWER_STATE_READY = 1 << 9;

export class Wifi {
  // Generic 16-bit register backing for the 32 KB window — keeps any
  // write/read round-trip that doesn't hit a specific handler honest.
  io = new Uint16Array(0x4000);
  chipId = 0x1440;
  powerState = 0;
  // 256 baseband regs; default 0xFF mirrors the chip's reset value
  // (uninitialized BB registers read all-ones).
  baseBandRegs = new Uint8Array(0x100);
  rxBufBegin = 0;
  rxBufEnd = 0;
  rxBufRdAddr = 0;
  txBufWrAddr = 0;

  constructor() {
    this.baseBandRegs.fill(0xFF);
  }

  read16(addr: number): number {
    addr = addr >>> 0;
    const off = (addr & 0x7FFE) >> 1;
    switch (addr) {
      case W_CHIPID:        return this.chipId & 0xFFFF;
      case W_POWER_STATE:   return this.powerState & 0xFFFF;
      case W_RXBUF_BEGIN:   return this.rxBufBegin & 0xFFFF;
      case W_RXBUF_END:     return this.rxBufEnd & 0xFFFF;
      case W_RXBUF_RD_ADDR: return this.rxBufRdAddr & 0xFFFF;
      case W_TXBUF_WR_ADDR: return this.txBufWrAddr & 0xFFFF;
      case W_BB_READ: {
        // The previous W_BB_CNT write specifies which BB reg to access.
        // We return that reg's shadow byte (default 0xFF).
        const ctrl = this.io[(W_BB_CNT & 0x7FFE) >> 1] ?? 0;
        const bbAddr = ctrl & 0xFF;
        return this.baseBandRegs[bbAddr] & 0xFF;
      }
    }
    return this.io[off] ?? 0;
  }

  write16(addr: number, value: number): void {
    addr = addr >>> 0;
    const v = value & 0xFFFF;
    const off = (addr & 0x7FFE) >> 1;
    switch (addr) {
      case W_MODE_RST:
        // Writing here resets sub-blocks of the chip. After reset,
        // power-state bit 9 (ready) should still reflect whether the
        // chip is powered. Games usually write this after powering up,
        // so don't clobber powerState.
        this.io[off] = v;
        return;
      case W_POWER_DOWN:
        // Any write here drops the chip into "off" — clear the ready
        // bit. Games that immediately probe again will write
        // W_POWER_STATE = 0x8001 to bring it back.
        this.powerState = 0;
        this.io[off] = v;
        return;
      case W_POWER_STATE: {
        // Real chip: bit 1 = power-up request, bit 0 = power-down.
        // The Nintendo SDK boot path writes 0x8001 (PM enable + power
        // down request) to deliberately put the chip to sleep before
        // re-enabling it — but our stub jumps straight to "powered up
        // & ready" whenever PM-enable (bit 15) is set, because the
        // polling loop after that point waits on the ready bit and we
        // never run the link layer.
        if ((v & 0x8000) !== 0) {
          this.powerState = (v & 0xFFFF) | POWER_STATE_READY;
        } else if ((v & 0x0002) !== 0) {
          this.powerState = (v & 0xFFFF) | POWER_STATE_READY;
        } else {
          this.powerState = v & 0xFFFF;
        }
        this.io[off] = this.powerState;
        return;
      }
      case W_RXBUF_BEGIN:
        this.rxBufBegin = v;
        this.io[off] = v;
        return;
      case W_RXBUF_END:
        this.rxBufEnd = v;
        this.io[off] = v;
        return;
      case W_RXBUF_RD_ADDR:
        this.rxBufRdAddr = v;
        this.io[off] = v;
        return;
      case W_TXBUF_WR_ADDR:
        this.txBufWrAddr = v;
        this.io[off] = v;
        return;
      case W_TXBUF_WR_DATA:
        // Drop TX data — there's nothing on the other end. Advance the
        // write pointer the way the real chip's autoincrement does so
        // any code polling that pointer makes progress.
        this.txBufWrAddr = (this.txBufWrAddr + 2) & 0x1FFE;
        this.io[(W_TXBUF_WR_ADDR & 0x7FFE) >> 1] = this.txBufWrAddr;
        return;
      case W_BB_CNT: {
        // bits 0..7: BB register address, bit 12: direction (1=write).
        // The BB write commits during the W_BB_CNT write on real
        // hardware; the value comes from W_BB_WRITE which the host
        // wrote before this.
        const bbAddr = v & 0xFF;
        const isWrite = (v & 0x1000) !== 0;
        if (isWrite) {
          const data = this.io[(W_BB_WRITE & 0x7FFE) >> 1] ?? 0;
          this.baseBandRegs[bbAddr] = data & 0xFF;
        }
        this.io[off] = v;
        return;
      }
      case W_BB_WRITE:
        // Latched here; the actual commit happens on the next W_BB_CNT
        // write with the write-direction bit set.
        this.io[off] = v;
        return;
      case W_POWER_US:
        // power-up delay — just a timing hint to the chip; store it.
        this.io[off] = v;
        return;
    }
    this.io[off] = v;
  }

  read8(addr: number): number {
    const aligned = addr & ~1;
    const halfword = this.read16(aligned);
    return (addr & 1) ? (halfword >>> 8) & 0xFF : halfword & 0xFF;
  }

  write8(addr: number, value: number): void {
    const aligned = addr & ~1;
    const off = (aligned & 0x7FFE) >> 1;
    const cur = this.io[off] ?? 0;
    const next = (addr & 1)
      ? (cur & 0x00FF) | ((value & 0xFF) << 8)
      : (cur & 0xFF00) | (value & 0xFF);
    this.write16(aligned, next & 0xFFFF);
  }

  read32(addr: number): number {
    const lo = this.read16(addr);
    const hi = this.read16((addr + 2) >>> 0);
    return ((hi << 16) | lo) >>> 0;
  }

  write32(addr: number, value: number): void {
    this.write16(addr, value & 0xFFFF);
    this.write16((addr + 2) >>> 0, (value >>> 16) & 0xFFFF);
  }
}
