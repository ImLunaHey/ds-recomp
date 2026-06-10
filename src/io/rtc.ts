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

  // Master-write buffer: bytes shifted in MSB-first after the cmd byte.
  // wrBits counts bits accumulated into wrCur; once 8 are gathered the
  // full byte is pushed into wrBytes and committed on SEL falling edge.
  wrBits = 0;
  wrCur = 0;
  wrBytes: number[] = [];

  // Persistent register state (writable via cmd-byte bit 7 = 0).
  // Defaults model a fresh chip: 24-hour mode, no alarm-enable bits,
  // no pending alarm interrupts. Alarm/free/clk-adj zeroed.
  status1 = 0x02;             // bit 1 = 24-hr mode
  status2 = 0x00;             // alarm interrupt sources
  alarm1: number[] = [0, 0, 0];
  alarm2: number[] = [0, 0, 0];
  clkAdj = 0x00;
  freeReg = 0x00;

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
      this.wrBits = 0;
      this.wrCur = 0;
      this.wrBytes = [];
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
      } else if ((this.cmd & 0x80) === 0) {
        // Cmd byte R/W bit = 0 → master writing data. Shift MSB-first
        // into wrCur; once 8 bits land, push a complete byte and reset.
        void writingData; // direction is informational only here.
        this.wrCur = ((this.wrCur << 1) & 0xFF) | (value & 1);
        this.wrBits++;
        if (this.wrBits === 8) {
          this.wrBytes.push(this.wrCur);
          this.wrCur = 0;
          this.wrBits = 0;
        }
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

    // SEL falling edge — end of transaction; commit any captured write
    // bytes to the addressed register, then clear assembly state.
    if (!newSel && this.selHigh) {
      if (this.byteReady && (this.cmd & 0x80) === 0 && this.wrBytes.length > 0) {
        this.commitWrite();
      }
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
        // Returned from persisted state so prior writes (e.g. INT1E/INT2E
        // enable bits) round-trip on subsequent reads.
        this.resp = [this.status1 & 0xFF];
        break;
      case 1:   // STATUS2
        // Holds alarm interrupt-source bits per GBATEK.
        this.resp = [this.status2 & 0xFF];
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
      case 4:   // ALARM1 — 3 bytes (dow+enable / hour+pm / minute). One-shot.
        this.resp = [this.alarm1[0]!, this.alarm1[1]!, this.alarm1[2]!];
        break;
      case 5:   // ALARM2 — 3 bytes, same format as ALARM1. Repeating.
        this.resp = [this.alarm2[0]!, this.alarm2[1]!, this.alarm2[2]!];
        break;
      case 6:   // CLK_ADJ — 1 byte (signed 6-bit + sign, frequency trim).
        this.resp = [this.clkAdj & 0xFF];
        break;
      case 7:   // FREE — 1 byte general-purpose register.
        this.resp = [this.freeReg & 0xFF];
        break;
      default:  // unreachable: cmdIdx is masked to 0..7.
        this.resp = [0x00];
        break;
    }
  }

  // Persist a master-write transaction. The host may have shifted in
  // fewer bytes than the canonical register width (the S3511 simply
  // accepts whatever it gets); we update only the bytes provided so
  // partial writes still round-trip cleanly.
  private commitWrite(): void {
    const cmdIdx = (this.cmd >> 4) & 0x7;
    const b = this.wrBytes;
    switch (cmdIdx) {
      case 0:   // STATUS1
        if (b.length >= 1) this.status1 = b[0]! & 0xFF;
        break;
      case 1:   // STATUS2
        if (b.length >= 1) this.status2 = b[0]! & 0xFF;
        break;
      case 2:   // DATE+TIME — host time is authoritative; ignore writes.
        break;
      case 3:   // TIME — host time is authoritative; ignore writes.
        break;
      case 4:   // ALARM1
        for (let i = 0; i < Math.min(b.length, 3); i++) this.alarm1[i] = b[i]! & 0xFF;
        break;
      case 5:   // ALARM2
        for (let i = 0; i < Math.min(b.length, 3); i++) this.alarm2[i] = b[i]! & 0xFF;
        break;
      case 6:   // CLK_ADJ
        if (b.length >= 1) this.clkAdj = b[0]! & 0xFF;
        break;
      case 7:   // FREE
        if (b.length >= 1) this.freeReg = b[0]! & 0xFF;
        break;
    }
  }
}
