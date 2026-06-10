// DS Real-Time Clock at register 0x04000138 (ARM7-only).
//
// The RTC is a separate SPI-like serial device on the NDS — NOT on the
// main SPI bus shared with firmware/touch/PM. The single 16-bit
// register at 0x04000138 implements a bit-banged 3-wire serial
// interface to a Seiko S3511-style chip. Register bits per GBATEK
// §"DS Real Time Clock":
//
//   bit 0: DATA  (data in, OR data out depending on direction)
//   bit 1: CLK   (clock — chip latches on rising edge)
//   bit 2: SEL   (chip select — active high)
//   bit 4: DATA direction (1 = ARM7 → RTC write)
//   bit 5: CLK direction  (1 = ARM7 → RTC write)
//   bit 6: SEL direction  (1 = ARM7 → RTC write)
//
// Protocol: SEL high to start, then 8 bits of command (MSB first), then
// either bytes of response (read) or written bytes. SEL low ends.
//
// Command byte format (MSB-first):
//   bit 7  : R/W (0 = Write, 1 = Read)
//   bits 6-4: command (0..7)
//   bits 3-0: always 0110b (= 6) — sanity tag
//
// Commands:
//   0 STATUS1, 1 STATUS2, 2 DATE+TIME (7), 3 TIME (3),
//   4 ALARM1 (3), 5 ALARM2 (3), 6 CLK_ADJ, 7 FREE
//
// We hand back fixed sensible defaults — Brain Training, Pokemon, etc.
// just need the RTC chip to respond at all so their boot sequence
// progresses; once they have a date they're happy. The date returned
// is the host's current date in BCD.

function bcd(n: number): number {
  return ((Math.floor(n / 10) << 4) | (n % 10)) & 0xFF;
}

export class Rtc {
  reg = 0;            // current 16-bit value of 0x04000138
  selHigh = false;    // last SEL state — rising edge resets bit counter
  clkHigh = false;    // last CLK state — rising edge shifts a bit

  cmdBits = 0;        // command bits collected so far (0..8)
  cmd = 0;            // command byte once fully assembled
  byteReady = false;  // command byte ready (response phase begins)

  // Response data + index into it for read commands. Filled when the
  // command byte completes; consumed one bit at a time.
  resp: number[] = [];
  respIdx = 0;

  // Date source — defaults to a fixed deterministic date so tests are
  // reproducible. Replace with a callback that returns the host clock
  // when running interactively from the browser UI.
  dateProvider: () => Date = () => new Date(2026, 5, 10, 14, 30, 0);

  read(): number { return this.reg & 0xFFFF; }

  write(value: number): void {
    const newSel = ((value >> 2) & 1) !== 0;
    const newClk = ((value >> 1) & 1) !== 0;
    const writingData = ((value >> 4) & 1) !== 0;

    // SEL rising edge — start of a transaction.
    if (newSel && !this.selHigh) {
      this.cmdBits = 0;
      this.cmd = 0;
      this.byteReady = false;
      this.resp = [];
      this.respIdx = 0;
    }

    // CLK rising edge AND chip selected — sample/shift a bit.
    if (newSel && newClk && !this.clkHigh) {
      if (!this.byteReady) {
        // Command-byte assembly phase. The chip clocks MSB first.
        this.cmd = ((this.cmd << 1) & 0xFF) | (value & 1);
        this.cmdBits++;
        if (this.cmdBits === 8) {
          this.byteReady = true;
          if ((this.cmd & 0x80) !== 0) this.prepareResponse();
        }
      } else if (writingData) {
        // Master writing data after the cmd byte — currently no-op
        // (we don't persist time-set / status writes). Bit is on bit 0.
        void value;
      } else {
        // Master reading data — return next response bit on bit 0.
        const byteIdx = (this.respIdx / 8) | 0;
        const bitIdx  = 7 - (this.respIdx % 8);
        const v = this.resp[byteIdx] ?? 0;
        const bit = (v >> bitIdx) & 1;
        this.reg = (this.reg & ~1) | bit;
        this.respIdx++;
      }
    }

    // SEL falling edge — end of transaction; preserve no state.
    if (!newSel && this.selHigh) {
      this.byteReady = false;
    }

    this.selHigh = newSel;
    this.clkHigh = newClk;
    // Update reg, preserving bits other than the data bit we may have
    // set above (so subsequent reads of 0x04000138 see correct state).
    this.reg = (this.reg & ~0xFE) | (value & 0xFE);
  }

  private prepareResponse(): void {
    // Top nibble selects command index 0..7.
    const cmdIdx = (this.cmd >> 4) & 0x7;
    const now = this.dateProvider();
    switch (cmdIdx) {
      case 0:   // STATUS1
        // Bit 1 = 24-hr mode (1), other bits 0 = no power-loss, no errors.
        this.resp = [0x02];
        break;
      case 1:   // STATUS2
        this.resp = [0x00];
        break;
      case 2:   // DATE+TIME (7 bytes: yr, mo, day, dow, hr, min, sec)
        this.resp = [
          bcd(now.getFullYear() % 100),
          bcd(now.getMonth() + 1),
          bcd(now.getDate()),
          bcd(now.getDay()),
          bcd(now.getHours()),
          bcd(now.getMinutes()),
          bcd(now.getSeconds()),
        ];
        break;
      case 3:   // TIME (3 bytes: hr, min, sec)
        this.resp = [
          bcd(now.getHours()),
          bcd(now.getMinutes()),
          bcd(now.getSeconds()),
        ];
        break;
      default:  // alarms, clock-adjust, free — return zeros
        this.resp = [0x00, 0x00, 0x00];
        break;
    }
  }
}
