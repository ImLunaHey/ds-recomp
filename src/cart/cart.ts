// NDS cartridge command interface. The game pokes a 64-bit command
// into ROMCMD (0x040001A8..AF) and a control word into ROMCTRL
// (0x040001A4). The control bit 31 (block-start) kicks off a transfer;
// the hardware loads the buffer and the CPU then reads ROMDATA
// (0x04100010) in 32-bit words.
//
// Real DS hardware has encrypted modes (KEY1, KEY2) and a long
// state machine. We model just the *unencrypted* path that handles:
//   0x9F: dummy (initial / not-ready)
//   0x00: read header (first 0x200 bytes of the ROM)
//   0x90: chip ID (4 bytes)
//   0xB7: read addressed data (32-bit address in command bytes 1..4)
//
// That's enough for the early ARM9/ARM7 sync where each side wants to
// verify the cart's there and pull a header/chip ID.

const BLOCK_SIZE_TABLE = [0, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000, 4];

export class Cart {
  rom: Uint8Array = new Uint8Array(0);

  // 8-byte command latch. Game writes one byte at a time at 0x1A8..AF.
  cmd = new Uint8Array(8);

  // Buffer prepared by startTransfer(). ROMDATA reads pull 32-bit words
  // from here. When `pos >= buf.length`, transfer is complete.
  buf = new Uint8Array(0);
  pos = 0;

  // Last ROMCTRL value (bit 31 = busy; we also keep block-size etc.).
  romctrl = 0;
  auxspicnt = 0;

  loadRom(rom: Uint8Array): void {
    this.rom = rom;
    this.cmd.fill(0);
    this.buf = new Uint8Array(0);
    this.pos = 0;
    this.romctrl = 0;
  }

  writeCmdByte(off: number, v: number): void { this.cmd[off & 7] = v & 0xFF; }
  readCmdByte(off: number): number { return this.cmd[off & 7]; }

  writeAuxSpiCnt(v: number): void { this.auxspicnt = v & 0xFFFF; }
  readAuxSpiCnt(): number { return this.auxspicnt & 0xFFFF; }
  readAuxSpiData(): number { return 0xFF; }      // empty save chip
  writeAuxSpiData(_v: number): void { /* stubbed */ }

  // ---- ROMCTRL ----
  readRomCtrl(): number {
    // Bit 23 = "word ready" — set when the buffer has data left to read.
    let ctrl = this.romctrl & 0x7F7FFFFF;
    if (this.pos < this.buf.length) ctrl |= 0x00800000;  // word-ready
    if (this.pos < this.buf.length) ctrl |= 0x80000000;  // still busy
    return ctrl >>> 0;
  }
  writeRomCtrl(v: number): void {
    const startBit = (v >>> 31) & 1;
    this.romctrl = v >>> 0;
    if (startBit) this.startTransfer();
  }

  // ---- ROMDATA ----
  readRomData(): number {
    if (this.pos + 4 > this.buf.length) {
      // No more data — return 0 and stay "not ready". Real HW returns
      // 0xFFFFFFFF after the last word.
      return 0xFFFFFFFF;
    }
    const v = this.buf[this.pos]
            | (this.buf[this.pos + 1] << 8)
            | (this.buf[this.pos + 2] << 16)
            | (this.buf[this.pos + 3] << 24);
    this.pos += 4;
    return v >>> 0;
  }

  private startTransfer(): void {
    // Block size — bits 24..26 of ROMCTRL.
    const bs = (this.romctrl >>> 24) & 7;
    const blockSize = BLOCK_SIZE_TABLE[bs];
    const cmd0 = this.cmd[0];

    if (blockSize === 0) {
      this.buf = new Uint8Array(0);
      this.pos = 0;
      return;
    }

    if (cmd0 === 0x9F) {
      // Dummy — fill with 0xFF.
      this.buf = new Uint8Array(blockSize);
      this.buf.fill(0xFF);
      this.pos = 0;
      return;
    }

    if (cmd0 === 0x00) {
      // Read header: stream the first 0x200 bytes of ROM, then mirror.
      this.buf = new Uint8Array(blockSize);
      for (let i = 0; i < blockSize; i++) {
        this.buf[i] = this.rom[i % 0x200] ?? 0;
      }
      this.pos = 0;
      return;
    }

    if (cmd0 === 0x90) {
      // Chip ID — 4 bytes repeated. We synthesize a Macronix-style ID
      // matching the ROM size class.
      const id = synthChipId(this.rom.length);
      this.buf = new Uint8Array(blockSize);
      for (let i = 0; i < blockSize; i += 4) {
        this.buf[i]     =  id        & 0xFF;
        this.buf[i + 1] = (id >>  8) & 0xFF;
        this.buf[i + 2] = (id >> 16) & 0xFF;
        this.buf[i + 3] = (id >> 24) & 0xFF;
      }
      this.pos = 0;
      return;
    }

    if (cmd0 === 0xB7) {
      // Read addressed data — bytes 1..4 of cmd hold the big-endian
      // 32-bit ROM address.
      let addr = (this.cmd[1] << 24) | (this.cmd[2] << 16) | (this.cmd[3] << 8) | this.cmd[4];
      addr >>>= 0;
      // Per GBATEK §"Cartridge Protocol Bus", reads below 0x8000 alias
      // to 0x8000 + (addr & 0x1FF). The secure area is exposed there.
      if (addr < 0x8000) addr = 0x8000 + (addr & 0x1FF);
      this.buf = new Uint8Array(blockSize);
      for (let i = 0; i < blockSize; i++) {
        const src = (addr + i) >>> 0;
        this.buf[i] = src < this.rom.length ? this.rom[src] : 0xFF;
      }
      this.pos = 0;
      return;
    }

    // Anything else — empty buffer.
    this.buf = new Uint8Array(blockSize);
    this.buf.fill(0xFF);
    this.pos = 0;
  }
}

// Synthesize a chip ID byte that encodes ROM size. Format per GBATEK:
//   bits  0..7  = manufacturer (0xC2 Macronix)
//   bits  8..15 = device capacity:
//                 (1 MB << n)-1 → byte = (n-3) for n in [3..7] = (rom_mb-1) in some sense.
//                 Easiest: floor(log2(rom_size_in_MB)) + 0xF8 (Nintendo-ish encoding)
//   bits 16..23 = always 0
//   bits 24..31 = misc flags (0x80 for >= 128 MB, 0 otherwise)
function synthChipId(romSize: number): number {
  const mb = romSize / (1024 * 1024);
  let sizeByte: number;
  if (mb >=  128) sizeByte = 0xFF;
  else if (mb >= 64) sizeByte = 0xFD;
  else if (mb >= 32) sizeByte = 0xFB;
  else if (mb >= 16) sizeByte = 0xF7;
  else if (mb >=  8) sizeByte = 0xEF;
  else if (mb >=  4) sizeByte = 0xDF;
  else                sizeByte = 0xBF;
  return ((mb >= 128 ? 0x80 : 0x00) << 24) | (sizeByte << 8) | 0xC2;
}
