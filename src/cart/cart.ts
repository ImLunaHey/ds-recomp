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

  // ---- Save backup chip (AUXSPI device) ----
  //
  // The DS has a separate SPI bus for the cart's save chip. SDK code
  // selects backup via AUXSPICNT bit 13, then performs byte exchanges
  // via AUXSPIDATA. The chip auto-detects type by addr-byte count:
  //   - EEPROM 512 B: 1 addr byte
  //   - EEPROM 8-64 KB: 2 addr bytes
  //   - FLASH/EEPROM 256 KB - 8 MB: 3 addr bytes
  // We start with a 1 MB FLASH-like backing, expanded on demand if a
  // game writes past the end. Status register reports "ready, not
  // protected" — matches what most SDK chip-detect probes expect.
  //
  // Commands handled (SPI standard):
  //   0x03 READ  — read data, addrSize-byte addr then data stream
  //   0x0B READ_HI — high-byte read (FLASH variant); same as 0x03 + +0x100
  //   0x02 WRITE — page program; same addr format then data writes
  //   0x0A WRITE_HI — high-byte write; same as 0x02 + +0x100
  //   0x05 RDSR  — read status register
  //   0x01 WRSR  — write status register (sets write-protect bits)
  //   0x06 WREN  — write enable
  //   0x04 WRDI  — write disable
  // Anything else returns 0xFF and ends quietly.
  // Empty flash chips read as 0xFF (= no bits programmed). Initialize
  // the backing blob accordingly so tests for "no save data" see the
  // right value.
  sav: Uint8Array = (() => { const a = new Uint8Array(0x100000); a.fill(0xFF); return a; })();
  savDirty = false;
  private savCmd = 0;
  private savAddr = 0;
  private savAddrBytes = 0;             // address bytes received in current tx
  private savBytePos = 0;               // overall byte index in current tx
  private savWriteEnabled = false;
  private savAddrSize = 3;              // auto-detect: assume 3 until proven less
  // Whether the SDK driver is asserting CS hold (AUXSPICNT bit 6 was 1
  // on the last write; released on transition 1 → 0).
  private auxHold = false;
  // Set when CS-hold transitions 1 → 0 mid-transaction. The chip
  // keeps CS asserted through the next data byte and releases after,
  // matching the deferred-CS behavior of every real SPI controller —
  // see the same fix in src/io/spi.ts. Pokemon's RDSR depends on
  // this: it sends 0x05 with CS-hold=1, then drops CS-hold=0 and
  // sends 0x00 expecting the status byte back.
  private auxReleaseAfterNext = false;
  // True after AUXSPICNT bit 13 = 1; SPI writes route to the save chip.
  private auxToBackup = false;
  // Last byte sent out by the save chip — read back by AUXSPIDATA.
  private auxOut = 0xFF;

  loadRom(rom: Uint8Array): void {
    this.rom = rom;
    this.cmd.fill(0);
    this.buf = new Uint8Array(0);
    this.pos = 0;
    this.romctrl = 0;
    this.phase = PHASE_RAW;
    this.key1CmdCount = 0;
    // Reset save state (but keep .sav blob — caller controls reload)
    this.savCmd = 0;
    this.savAddr = 0;
    this.savAddrBytes = 0;
    this.savBytePos = 0;
    this.savWriteEnabled = false;
    this.savAddrSize = 3;
    this.auxHold = false;
    this.auxToBackup = false;
    this.auxOut = 0xFF;
  }

  // Replace the save blob (caller responsible for fitting / extending).
  loadSav(data: Uint8Array): void {
    this.sav = new Uint8Array(Math.max(data.length, 0x100000));
    this.sav.fill(0xFF);
    this.sav.set(data, 0);
    this.savDirty = false;
  }

  writeCmdByte(off: number, v: number): void { this.cmd[off & 7] = v & 0xFF; }
  readCmdByte(off: number): number { return this.cmd[off & 7]; }

  writeAuxSpiCnt(v: number): void {
    const newHold = ((v >> 6) & 1) !== 0;
    const newSelectBackup = ((v >> 13) & 1) !== 0;
    // CS-hold falling 1 → 0 mid-transaction: defer end-of-transaction
    // until after the NEXT data byte (Pokemon's RDSR depends on this).
    // If we end immediately, the next DAT_W is treated as a new
    // command and the SDK reads 0xFF instead of the status byte.
    if (this.auxHold && !newHold && this.savBytePos > 0) {
      this.auxReleaseAfterNext = true;
    }
    // CS rising 0 → 1 also starts a new transaction. If a previous one
    // was left deferred without delivering its final byte, just reset
    // — no chance to ever deliver it now.
    if (!this.auxHold && newHold) {
      this.savCmd = 0;
      this.savAddrBytes = 0;
      this.savBytePos = 0;
      this.auxReleaseAfterNext = false;
    }
    this.auxHold = newHold;
    this.auxToBackup = newSelectBackup;
    this.auxspicnt = v & 0xFFFF;
  }
  readAuxSpiCnt(): number { return this.auxspicnt & 0xFFFF; }
  readAuxSpiData(): number { return this.auxOut & 0xFF; }
  writeAuxSpiData(v: number): void {
    if (!this.auxToBackup) {
      // ROM-side AUXSPI access — not modeled separately; just clear.
      this.auxOut = 0xFF;
      return;
    }
    this.auxOut = this.savTickByte(v & 0xFF);
    // If the SDK released CS-hold before this byte, the byte just
    // exchanged was the final one — end the transaction now.
    if (this.auxReleaseAfterNext) {
      this.savCmd = 0;
      this.savAddrBytes = 0;
      this.savBytePos = 0;
      this.auxReleaseAfterNext = false;
    }
  }

  // SPI byte exchange with the save chip. Returns the byte the chip
  // shifts out in this cycle. State is per-transaction (reset by CS
  // release in writeAuxSpiCnt).
  private savTickByte(byte: number): number {
    const pos = this.savBytePos++;
    if (pos === 0) {
      this.savCmd = byte;
      this.savAddr = 0;
      this.savAddrBytes = 0;
      // Single-byte commands (no further data) apply their effect on
      // the command byte. The chip's response to byte 0 of any SPI
      // exchange is the previous shift-out (= "0xFF for stale").
      if (byte === 0x06) this.savWriteEnabled = true;        // WREN
      else if (byte === 0x04) this.savWriteEnabled = false;  // WRDI
      // Some commands carry an offset in the cmd byte itself:
      // 0x0B/0x0A = "high-half" variants; they imply +0x100 on the
      // computed address (for EEPROM 512 B).
      return 0xFF;
    }
    switch (this.savCmd) {
      case 0x05: {                                       // RDSR
        // Bits 0,1 = WIP, WEL. We're never busy; report WEL state.
        // High bits 4-7 = block-protect + status-reg-write-disable.
        // We must return 0 there: ORing 0xF0 made the chip look fully
        // write-protected, which Simpsons Game interpreted as "save
        // chip inaccessible" and displayed "data could not be
        // accessed" on the title screen instead of booting normally.
        return this.savWriteEnabled ? 0x02 : 0x00;
      }
      case 0x06: this.savWriteEnabled = true;  return 0xFF;   // WREN
      case 0x04: this.savWriteEnabled = false; return 0xFF;   // WRDI
      case 0x01: {                                       // WRSR
        // Status reg write — accept silently, ignore protect bits.
        return 0xFF;
      }
      case 0x03: case 0x0B: {                            // READ / READ_HI
        if (this.savAddrBytes < this.savAddrSize) {
          this.savAddr = ((this.savAddr << 8) | byte) >>> 0;
          this.savAddrBytes++;
          if (this.savAddrBytes < this.savAddrSize) return 0xFF;
          // Final address byte — apply high-variant offset for
          // EEPROM 512 B encoding.
          if (this.savCmd === 0x0B && this.savAddrSize === 1) {
            this.savAddr += 0x100;
          }
          return 0xFF;
        }
        // Data phase — stream save bytes.
        const a = this.savAddr++ & (this.sav.length - 1);
        return this.sav[a] ?? 0xFF;
      }
      case 0x02: case 0x0A: {                            // WRITE / WRITE_HI
        if (this.savAddrBytes < this.savAddrSize) {
          this.savAddr = ((this.savAddr << 8) | byte) >>> 0;
          this.savAddrBytes++;
          if (this.savAddrBytes < this.savAddrSize) return 0xFF;
          if (this.savCmd === 0x0A && this.savAddrSize === 1) {
            this.savAddr += 0x100;
          }
          return 0xFF;
        }
        if (!this.savWriteEnabled) return 0xFF;
        const a = this.savAddr++ & (this.sav.length - 1);
        this.sav[a] = byte;
        this.savDirty = true;
        return 0xFF;
      }
      case 0x9F: {                                       // RDID (JEDEC ID)
        // Three-byte JEDEC ID for a Macronix-like 1 MB FLASH.
        if (pos === 1) return 0xC2;
        if (pos === 2) return 0x20;
        if (pos === 3) return 0x14;
        return 0xFF;
      }
      default:
        return 0xFF;
    }
  }

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
