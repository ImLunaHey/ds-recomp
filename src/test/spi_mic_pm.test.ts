import { describe, it, expect, beforeEach } from 'vitest';
import { Spi } from '../io/spi';

// Helper: drive a complete SPI transaction against `spi`. Selects
// `device`, asserts CS-hold for every byte but the last, and returns
// the byte exchanged on each step.
function txn(spi: Spi, device: number, bytes: number[]): number[] {
  const replies: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const last = i === bytes.length - 1;
    // SPICNT: enable (bit 15) + device select (bits 8-9) + CS-hold (bit 11)
    // on every byte except the final one (which releases CS at the end).
    const cnt = 0x8000 | (device << 8) | (last ? 0 : (1 << 11));
    spi.writeCnt(cnt);
    spi.writeData(bytes[i]);
    replies.push(spi.readData());
  }
  return replies;
}

// Read the 12-bit ADC value back from a touchscreen control-byte
// transaction (control + 2 data bytes). The TSC2046 packs the result
// as 7 high bits in byte 1, 5 low bits in the high nibble of byte 2.
function tscRead(spi: Spi, ch: number): number {
  const reply = txn(spi, 2, [(ch << 4) | 0x80, 0x00, 0x00]);
  const hi = reply[1] & 0x7F;
  const lo = (reply[2] >> 3) & 0x1F;
  return (hi << 5) | lo;
}

describe('SPI microphone (TSC2046 AUX, channel 6)', () => {
  let spi: Spi;
  beforeEach(() => { spi = new Spi(); });

  it('returns ADC midpoint (0x800) by default when no sample is set', () => {
    expect(tscRead(spi, 6)).toBe(0x800);
  });

  it('returns the externally-set micSample value', () => {
    spi.micSample = 0x123;
    expect(tscRead(spi, 6)).toBe(0x123);
  });

  it('mic sample is independent of touch state', () => {
    spi.micSample = 0x456;
    spi.touchX = 100; spi.touchY = 100;
    expect(tscRead(spi, 6)).toBe(0x456);
    spi.touchX = null; spi.touchY = null;
    expect(tscRead(spi, 6)).toBe(0x456);
  });

  it('mic sample is masked to 12 bits', () => {
    spi.micSample = 0x1FFF;
    expect(tscRead(spi, 6)).toBe(0xFFF);
  });
});

describe('SPI power-management registers', () => {
  let spi: Spi;
  beforeEach(() => { spi = new Spi(); });

  it('reg 0 round-trips a write/read', () => {
    // Write reg 0 = 0x0D (typical retail bring-up: sound + both LCDs on).
    txn(spi, 0, [0x00, 0x0D]);
    // Read reg 0 (command byte high bit = 1 → read).
    const reply = txn(spi, 0, [0x80, 0x00]);
    expect(reply[1]).toBe(0x0D);
    expect(spi.pmRegs[0]).toBe(0x0D);
  });

  it('reg 4 backlight brightness write persists', () => {
    txn(spi, 0, [0x04, 0x55]);
    expect(spi.pmRegs[4]).toBe(0x55);
    const reply = txn(spi, 0, [0x84, 0x00]);
    expect(reply[1]).toBe(0x55);
  });

  it('writes to multiple registers do not interfere', () => {
    txn(spi, 0, [0x00, 0x0D]);     // reg 0
    txn(spi, 0, [0x01, 0x03]);     // reg 1 (backlight enable, both screens)
    txn(spi, 0, [0x04, 0x10]);     // reg 4 (top brightness)
    txn(spi, 0, [0x05, 0x20]);     // reg 5 (bottom brightness)
    expect(spi.pmRegs[0]).toBe(0x0D);
    expect(spi.pmRegs[1]).toBe(0x03);
    expect(spi.pmRegs[4]).toBe(0x10);
    expect(spi.pmRegs[5]).toBe(0x20);
  });

  it('out-of-range register index reads as 0 and is ignored on write', () => {
    const reply = txn(spi, 0, [0x87, 0x00]);     // reg 7 (within range, default 0)
    expect(reply[1]).toBe(0);
    // Reg 8 is out of the 8-byte file: write is dropped, read returns 0.
    txn(spi, 0, [0x08, 0xAB]);
    const r2 = txn(spi, 0, [0x88, 0x00]);
    expect(r2[1]).toBe(0);
  });
});

describe('SPI touch panel: nonlinear pressure', () => {
  let spi: Spi;
  beforeEach(() => { spi = new Spi(); });

  it('Z1 reads higher (more position offset) at panel edge than at center', () => {
    spi.touchX = 128; spi.touchY = 96;          // dead center
    const z1Center = tscRead(spi, 3);
    spi.touchX = 32;  spi.touchY = 96;          // left edge
    const z1Edge = tscRead(spi, 3);
    expect(z1Center).toBe(0x100);
    expect(z1Edge).toBe(0x100 + 96);
    expect(z1Edge).toBeGreaterThan(z1Center);
  });

  it('Z2 also varies with touch X-offset from center', () => {
    spi.touchX = 128; spi.touchY = 96;
    const z2Center = tscRead(spi, 4);
    spi.touchX = 224; spi.touchY = 96;
    const z2Edge = tscRead(spi, 4);
    expect(z2Center).toBe(0xE00);
    expect(z2Edge).toBe(0xE00 + 96);
  });

  it('released Z1/Z2 still report no-touch values regardless of micSample', () => {
    spi.micSample = 0x321;
    expect(tscRead(spi, 3)).toBe(0xFFF);
    expect(tscRead(spi, 4)).toBe(0x000);
  });
});
