// Minimal SPI bus emulation for ARM7. The DS SPI bus has four
// devices: 0 = Power Management, 1 = Firmware flash, 2 = Touchscreen,
// 3 = reserved. SPICNT (0x040001C0) selects the device and controls
// chip-select hold; SPIDATA (0x040001C2) is the byte-exchange port.
//
// Each transfer ARM7 issues is one byte exchange: ARM7 writes to
// SPIDATA, SPI shifts ARM7's byte to the device and the device's
// reply back into SPIDATA for ARM7 to read. Real hardware sets bit 7
// of SPICNT (busy) for the transfer duration; we complete instantly
// and never set busy.
//
// Our goal here is breadth, not depth — return plausible values for
// every device so ARM7 init code stops polling and progresses to its
// main loop where the IPCSYNC handshake with ARM9 happens.

export class Spi {
  // SPICNT (16-bit). Bits:
  //   0-1   baud
  //   7     busy (we always clear)
  //   8-9   device select (0=PM, 1=Firmware, 2=Touchscreen, 3=reserved)
  //   10    transfer size (0=8-bit, 1=16-bit)
  //   11    chip-select hold (1 = keep CS asserted for next exchange)
  //   13    IRQ on transfer complete
  //   15    SPI enable
  cnt = 0;

  // Response byte that SPIDATA returns on the next read.
  data = 0;

  // Transaction state. Reset whenever CS is released (cnt bit 11 falls
  // 1 → 0) or when we move to a different device.
  private device = 0;
  private bytePos = 0;
  private fwCmd = 0;
  private fwAddr = 0;
  private tscChannel = 0;

  // 256 KB firmware blob. Populated with sane defaults so the most
  // commonly read fields (user settings, touchscreen calibration,
  // language) are non-garbage.
  firmware: Uint8Array;

  constructor() {
    this.firmware = new Uint8Array(0x40000);
    this.initFirmware();
  }

  // Set up the user-settings block at the end of firmware. GBATEK
  // §"DS Firmware User Settings" describes the 0x100-byte layout
  // at offset 0x3FE00 (latest user settings slot).
  private initFirmware(): void {
    const off = 0x3FE00;
    const f = this.firmware;

    // Header marker (version, etc.) — anything plausibly non-zero.
    f[off + 0x00] = 5;          // version
    f[off + 0x01] = 0;

    // Touchscreen calibration: two reference points. The NDS expects
    // ADC-space coords (0..0xFFF) paired with screen-space pixel
    // coords (0..255 X, 0..191 Y). Set up a clean identity-style
    // mapping so any code that uses the calibration produces sane
    // pixel positions.
    // 0x58: tscX1 (u16), tscY1 (u16), tscPX1 (u8), tscPY1 (u8)
    // 0x5E: tscX2 (u16), tscY2 (u16), tscPX2 (u8), tscPY2 (u8)
    const w16 = (a: number, v: number): void => { f[a] = v & 0xFF; f[a + 1] = (v >> 8) & 0xFF; };
    w16(off + 0x58, 0x200);     // adc X1
    w16(off + 0x5A, 0x200);     // adc Y1
    f[off + 0x5C] = 32;         // pixel X1
    f[off + 0x5D] = 32;         // pixel Y1
    w16(off + 0x5E, 0xE00);     // adc X2
    w16(off + 0x60, 0xE00);     // adc Y2
    f[off + 0x62] = 224;        // pixel X2
    f[off + 0x63] = 160;        // pixel Y2

    // Language / flags at 0x64 (bits 0-2 = language; 1 = English).
    f[off + 0x64] = 0x01;

    // Birthday / nickname / message — leave zero.

    // Update counter (16-bit, must be non-zero so this slot wins
    // against the alternate slot at 0x3FF00).
    w16(off + 0x70, 0x0001);

    // CRC-16 over bytes 0x00..0x6F (CCITT, init 0xFFFF) at 0x72.
    const crc = crc16ccitt(f, off, 0x70);
    w16(off + 0x72, crc);

    // Also stamp the alternate slot at 0x3FF00 with a smaller counter
    // so the firmware code picks the 0x3FE00 slot.
    f.copyWithin(0x3FF00, off, off + 0x100);
    w16(0x3FF70, 0x0000);
    w16(0x3FF72, crc16ccitt(f, 0x3FF00, 0x70));
  }

  // ---- Register interface ----

  readCnt(): number { return this.cnt & 0xFFFF; }

  writeCnt(v: number): void {
    const oldHold = (this.cnt >> 11) & 1;
    const newHold = (v >> 11) & 1;
    const newDev  = (v >> 8) & 0x3;
    // If CS was asserted and is now released, OR the selected device
    // changed mid-transaction, the current transaction ends.
    if ((oldHold && !newHold) || (this.bytePos > 0 && newDev !== this.device)) {
      this.endTransaction();
    }
    this.device = newDev;
    // Mask off busy bit on writes — we never report busy.
    this.cnt = v & 0xFFFF & ~0x80;
  }

  readData(): number { return this.data & 0xFF; }

  writeData(v: number): void {
    const byte = v & 0xFF;
    // Default response: 0xFF (open SPI bus pulls high).
    let response = 0xFF;

    switch (this.device) {
      case 0: response = this.tickPowerManagement(byte); break;
      case 1: response = this.tickFirmware(byte);        break;
      case 2: response = this.tickTouchscreen(byte);     break;
      case 3: response = 0xFF;                            break;
    }
    this.data = response;
    this.bytePos++;

    // If CS is NOT being held, this is a single-byte transaction —
    // end immediately so the next write starts a new one.
    if (!((this.cnt >> 11) & 1)) this.endTransaction();
  }

  // ---- Per-device state machines ----

  private tickFirmware(byte: number): number {
    if (this.bytePos === 0) {
      this.fwCmd = byte;
      this.fwAddr = 0;
      return 0xFF;
    }
    switch (this.fwCmd) {
      case 0x03: {   // READ
        if (this.bytePos <= 3) {
          this.fwAddr = ((this.fwAddr << 8) | byte) & 0xFFFFFF;
          return 0xFF;
        }
        const r = this.firmware[this.fwAddr & (this.firmware.length - 1)];
        this.fwAddr = (this.fwAddr + 1) & (this.firmware.length - 1);
        return r;
      }
      case 0x05:     // RDSR — status register: bit 0 = WIP (busy), bit 1 = WEL.
        return 0x00;
      case 0x9F:     // RDID — manufacturer / device ID. Pretend we're a real chip.
        if (this.bytePos === 1) return 0x20;       // mfr
        if (this.bytePos === 2) return 0x40;       // dev hi
        if (this.bytePos === 3) return 0x12;       // dev lo
        return 0xFF;
      default:
        return 0xFF;
    }
  }

  private tickTouchscreen(byte: number): number {
    // The TSC2046-like control byte sent first carries the channel in
    // bits 4..6. We return a 12-bit "no touch" reading split across
    // two response bytes. Returning 0 means the screen wasn't pressed.
    if (this.bytePos === 0) {
      this.tscChannel = (byte >> 4) & 0x7;
      return 0x00;
    }
    void this.tscChannel;
    return 0x00;
  }

  private tickPowerManagement(byte: number): number {
    // PM chip — register read/write. We treat all registers as zero.
    // Real layout has bits for sound enable, LCD enable, LED, etc.
    void byte;
    return 0x00;
  }

  private endTransaction(): void {
    this.bytePos = 0;
    this.fwCmd = 0;
    this.fwAddr = 0;
    this.tscChannel = 0;
  }
}

function crc16ccitt(buf: Uint8Array, off: number, len: number): number {
  let crc = 0xFFFF;
  for (let i = 0; i < len; i++) {
    crc ^= buf[off + i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
    }
  }
  return crc & 0xFFFF;
}
