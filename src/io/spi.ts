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
  // Real DS SPI hardware: when SPICNT bit 11 (CS-hold) transitions
  // 1 → 0 mid-transaction, the chip select stays asserted until *after*
  // the next byte completes. The Nintendo SDK SPI driver relies on
  // this: it lowers CS-hold, then writes one more SPIDATA byte to
  // read the status/data byte as the last byte of the transaction.
  // Without the deferral, that final byte starts a NEW transaction
  // (with cmd = 0), gets back 0xFF, and the driver (e.g. NSMB's RDSR
  // status poll at ARM7 0x27F58E4) sees WEL=1 forever and spins.
  private releaseAfterNext = false;

  // 256 KB firmware blob. Populated with sane defaults so the most
  // commonly read fields (user settings, touchscreen calibration,
  // language) are non-garbage.
  firmware: Uint8Array;

  constructor() {
    this.firmware = new Uint8Array(0x80000);   // 512 KB to match retail DS firmware
    this.initFirmware();
  }

  // Set up the user-settings block at the end of firmware. GBATEK
  // §"DS Firmware User Settings" describes the 0x100-byte layout
  // at offset 0x3FE00 (latest user settings slot).
  private initFirmware(): void {
    const f = this.firmware;
    // 0x00-0x1F: firmware header. Per real DS firmware layout:
    //   0x00-0x01: ARM9 boot code GUI offset (16-bit, value × 8 = ROM offset)
    //   0x02-0x03: ARM7 boot code GUI offset
    //   0x04-0x05: GUI/WiFi panic offset (decompression src in ROM)
    //   0x06-0x07: WiFi data offset
    //   0x08-0x09: ARM9 boot RAM dest >> 8 (typ. 0x3FFF8 / 0x100 = 0x3FF8)
    //   0x0A-0x0B: ARM7 boot RAM dest >> 8
    //   0x0C: type (= 0xFF for retail)
    //   0x0D: bootcode CRC8
    //   0x0E-0x0F: timestamp
    //   0x14-0x1F: ARM9 GUI/menu CRC, ARM7 GUI/menu CRC etc.
    // Many games verify these CRCs match; without real firmware bytes
    // we just stamp plausible non-zero values so the verifier passes.
    // Populate the firmware header to a plausible retail layout. The
    // 16-bit offsets here are in 8-byte units. Values mirror what
    // typical retail firmware (consistent with melonDS's HLE) emits:
    // GUI bootcode lives just past the header.
    const w16h = (a: number, v: number): void => { f[a] = v & 0xFF; f[a + 1] = (v >> 8) & 0xFF; };
    w16h(0x00, 0x0020);     // ARM9 GUI offset / 8 (= 0x100)
    w16h(0x02, 0x0040);     // ARM7 GUI offset / 8 (= 0x200)
    w16h(0x04, 0x0080);     // panic offset / 8
    w16h(0x06, 0x7F00);     // WiFi data offset / 8 (≈ 0x3F800)
    w16h(0x08, 0x3FF8);     // ARM9 boot RAM dest >> 8
    w16h(0x0A, 0x3FF8);     // ARM7 boot RAM dest >> 8
    f[0x0C] = 0xFF;          // type (retail)
    f[0x0D] = 0x00;          // bootcode CRC8 (placeholder)
    w16h(0x0E, 0x4D17);     // timestamp (arbitrary)
    f[0x1D] = 0x05;          // firmware version
    // 0x14-0x1F: CRCs over the GUI code regions. Stamp computed CRCs
    // over zero-filled GUI regions so verifiers see "code = zeros, CRC
    // = CRC(zeros)" and accept it as consistent (real games only check
    // these to detect firmware corruption — they don't verify against
    // a specific known-good value).
    const arm9GuiStart = 0x100, arm9GuiLen = 0x800;
    const arm7GuiStart = 0x200, arm7GuiLen = 0x800;
    w16h(0x14, crc16ccitt(f, arm9GuiStart, arm9GuiLen));
    w16h(0x16, crc16ccitt(f, arm7GuiStart, arm7GuiLen));
    // WiFi calibration / RF settings live at the offset stamped in
    // header[0x06]. Region 0x3F800-0x3FBFF holds calibration data;
    // leaving these zero-filled is generally safe for retail games
    // that only do WiFi setup on first boot (we never reach that).
    // User-settings block at the end of firmware.
    const off = 0x3FE00;

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
    // Device change mid-transaction always ends it immediately.
    if (this.bytePos > 0 && newDev !== this.device) {
      this.endTransaction();
      this.releaseAfterNext = false;
    }
    // CS-hold falling 1 → 0 mid-transaction: defer the end-of-
    // transaction until after the NEXT byte completes (see field doc).
    if (oldHold && !newHold && this.bytePos > 0) {
      this.releaseAfterNext = true;
    }
    this.device = newDev;
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

    // End transaction if CS-hold is currently 0 (single-byte transaction)
    // OR if the previous writeCnt deferred a "release after next byte".
    const hold = (this.cnt >> 11) & 1;
    if (!hold || this.releaseAfterNext) {
      this.endTransaction();
      this.releaseAfterNext = false;
    }
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
    // The TSC2046-like control byte arrives first; bits 4..6 select
    // the channel. The response is a one-bit dummy zero, then 12 bits
    // of data MSB-first, then trailing zeros, split across the next
    // two byte exchanges.
    // Per GBATEK channel 1 = Y (released value = 0xFFF), channel 5 = X
    // (released value = 0x000). Returning these tells the SDK driver
    // "pen not down".
    if (this.bytePos === 0) {
      this.tscChannel = (byte >> 4) & 0x7;
      return 0x00;
    }
    const value12 = this.tscChannel === 1 ? 0xFFF : 0x000;
    if (this.bytePos === 1) return (value12 >> 5) & 0x7F;
    if (this.bytePos === 2) return (value12 & 0x1F) << 3;
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
