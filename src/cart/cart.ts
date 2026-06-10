// NDS cartridge command interface. The game pokes a 64-bit command
// into ROMCMD (0x040001A8..AF) and a control word into ROMCTRL
// (0x040001A4). The control bit 31 (block-start) kicks off a transfer;
// the hardware loads the buffer and the CPU then reads ROMDATA
// (0x04100010) in 32-bit words.
//
// We model the three protocol phases per GBATEK §"DS Cart Protocol":
//
//   PHASE_RAW     (boot): 0x9F=dummy, 0x00=read header, 0x90=chip ID
//   PHASE_KEY1    after cmd 0x3C (activate KEY1):
//                   - first KEY1 cmd → chip ID (encrypted; we stub the
//                     same bytes the unencrypted 0x90 returns)
//                   - next ~2KB worth of KEY1 cmds → secure-area read
//                     (we just stream ROM bytes 0x4000-0x7FFF as if
//                     the cart's secure-area block is in the clear)
//                   - cmd encoding for 0xA0 → switch to KEY2
//   PHASE_KEY2    cmds use encrypted 0xB7 (read addressed data) and
//                 0xB8 (chip ID). We treat KEY2 as effectively
//                 transparent — the cart's KEY2 cipher is a 64-bit
//                 LFSR keyed off chip ID + per-transfer counter, and
//                 GAMES NEVER VERIFY the ciphertext directly; they
//                 just read the data ARM-side after the SDK decrypts.
//                 So returning plain bytes works for everything that
//                 doesn't strictly check encryption (Pokemon's anti-
//                 piracy DOES check; everything else doesn't).
//
// No real BIOS bytes are used. Games requiring authentic KEY1 (= per-
// game-id Blowfish derived from ARM7 BIOS bytes 0x0030-0x1078) won't
// be satisfied by this stub. But this gives us a valid state machine
// every other game's SDK cart driver expects to see.

const BLOCK_SIZE_TABLE = [0, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000, 4];

const PHASE_RAW = 0;
const PHASE_KEY1 = 1;
const PHASE_KEY2 = 2;

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

  // Protocol phase. Games transition RAW → KEY1 → KEY2 during boot.
  phase = PHASE_RAW;
  // Counter of KEY1-phase commands seen. First few are chip ID + secure
  // area; eventually one carries the activate-KEY2 marker.
  key1CmdCount = 0;
  // Callback registered by IO module so we can ping cart-ready DMA when
  // a transfer's buffer is filled.
  onTransferReady: (() => void) | null = null;
  // Bit 14 of AUXSPICNT enables transfer-end IRQ; set by IO module
  // wiring to raise IRQ_CART (bit 19) when the buffer drains.
  onTransferEnd: (() => void) | null = null;

  loadRom(rom: Uint8Array): void {
    this.rom = rom;
    this.cmd.fill(0);
    this.buf = new Uint8Array(0);
    this.pos = 0;
    this.romctrl = 0;
    this.phase = PHASE_RAW;
    this.key1CmdCount = 0;
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
      // No more data — return 0xFFFFFFFF per real HW after the last word.
      return 0xFFFFFFFF;
    }
    const v = this.buf[this.pos]
            | (this.buf[this.pos + 1] << 8)
            | (this.buf[this.pos + 2] << 16)
            | (this.buf[this.pos + 3] << 24);
    this.pos += 4;
    // Last word → fire transfer-end IRQ if AUXSPICNT bit 14 is set.
    if (this.pos >= this.buf.length && ((this.auxspicnt >> 14) & 1) !== 0) {
      this.onTransferEnd?.();
    }
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

    if (this.phase === PHASE_RAW) {
      this.runRawCommand(cmd0, blockSize);
    } else if (this.phase === PHASE_KEY1) {
      this.runKey1Command(blockSize);
    } else {
      // PHASE_KEY2 — KEY2 cipher is transparent for our stub. The
      // SDK driver expects cmd 0xB7 (read) and 0xB8 (chip ID); the
      // RAW handlers do the right thing.
      this.runRawCommand(cmd0, blockSize);
    }
    // Notify DMA that the buffer is ready for cart-ready timing.
    this.onTransferReady?.();
  }

  private runRawCommand(cmd0: number, blockSize: number): void {
    if (cmd0 === 0x9F) {
      this.buf = new Uint8Array(blockSize);
      this.buf.fill(0xFF);
      this.pos = 0;
      return;
    }
    if (cmd0 === 0x00) {
      this.buf = new Uint8Array(blockSize);
      for (let i = 0; i < blockSize; i++) {
        this.buf[i] = this.rom[i % 0x200] ?? 0;
      }
      this.pos = 0;
      return;
    }
    if (cmd0 === 0x90 || cmd0 === 0xB8) {
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
    if (cmd0 === 0x3C) {
      // Activate KEY1 mode. No data exchanged; cart starts replying to
      // encrypted commands afterwards. We fill the response buffer with
      // 0x00 (SDK driver expects "success" sentinel).
      this.phase = PHASE_KEY1;
      this.key1CmdCount = 0;
      this.buf = new Uint8Array(blockSize);
      this.pos = 0;
      return;
    }
    if (cmd0 === 0xB7) {
      let addr = (this.cmd[1] << 24) | (this.cmd[2] << 16) | (this.cmd[3] << 8) | this.cmd[4];
      addr >>>= 0;
      if (addr < 0x8000) addr = 0x8000 + (addr & 0x1FF);
      this.buf = new Uint8Array(blockSize);
      for (let i = 0; i < blockSize; i++) {
        const src = (addr + i) >>> 0;
        this.buf[i] = src < this.rom.length ? this.rom[src] : 0xFF;
      }
      this.pos = 0;
      return;
    }
    this.buf = new Uint8Array(blockSize);
    this.buf.fill(0xFF);
    this.pos = 0;
  }

  private runKey1Command(blockSize: number): void {
    // The SDK driver sends a fixed-ish sequence after 0x3C:
    //   1× chip-ID read   → return chip ID
    //   ~4× secure-area block reads (each 0x200 bytes from ROM 0x4000+)
    //   1× activate-KEY2 cmd → switch phase
    // We use the call counter as a state machine. The cart's KEY1
    // decryption produces a 56-bit command whose top nibble (bits
    // 60-63 of the 64-bit encrypted cmd) is the actual opcode. Our
    // stub ignores the opcode and goes by call order.
    this.key1CmdCount++;
    const n = this.key1CmdCount;

    // After ~6 KEY1 commands, transition to KEY2.
    if (n >= 6) {
      this.phase = PHASE_KEY2;
      // Cart returns 0x00 for the activate-KEY2 ack.
      this.buf = new Uint8Array(blockSize);
      this.pos = 0;
      return;
    }
    if (n === 1) {
      // Chip ID.
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
    // Secure area read. Block N (1-indexed; we already used 1 for chip
    // ID) maps to ROM offset 0x4000 + (n-2)*0x200.
    const addr = 0x4000 + (n - 2) * 0x200;
    this.buf = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
      const src = (addr + i) >>> 0;
      this.buf[i] = src < this.rom.length ? this.rom[src] : 0xFF;
    }
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
