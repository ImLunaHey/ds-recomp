import { describe, it, expect } from 'vitest';
import { Cart } from '../cart/cart';

// Drive a multi-byte SPI exchange to the cart's save chip the way the
// Nintendo SDK driver does: set CS-hold = 1, write the command byte,
// then a chain of address bytes, then data bytes, then drop CS-hold.

function selectBackup(cart: Cart, hold: boolean): void {
  // AUXSPICNT: bit 6 = hold, bit 13 = backup select, bit 15 = enable.
  let v = (1 << 13) | (1 << 15);
  if (hold) v |= (1 << 6);
  cart.writeAuxSpiCnt(v);
}

function exchange(cart: Cart, byte: number): number {
  cart.writeAuxSpiData(byte);
  return cart.readAuxSpiData();
}

describe('Cart save backup', () => {
  it('returns 0xFF when reading from an empty save', () => {
    const cart = new Cart();
    cart.loadRom(new Uint8Array(0x10000));
    selectBackup(cart, true);
    exchange(cart, 0x03);            // READ
    exchange(cart, 0x00);            // addr byte 1
    exchange(cart, 0x00);            // addr byte 2
    exchange(cart, 0x00);            // addr byte 3 (3-byte addr default)
    expect(exchange(cart, 0x00)).toBe(0xFF);
    expect(exchange(cart, 0x00)).toBe(0xFF);
    selectBackup(cart, false);
  });

  it('WREN + WRITE persists, RDSR reflects WEL bit', () => {
    const cart = new Cart();
    cart.loadRom(new Uint8Array(0x10000));
    // RDSR before WREN — bit 1 clear.
    selectBackup(cart, true);
    exchange(cart, 0x05);
    expect(exchange(cart, 0x00) & 0x02).toBe(0);
    selectBackup(cart, false);
    // WREN.
    selectBackup(cart, true);
    exchange(cart, 0x06);
    selectBackup(cart, false);
    // RDSR after WREN — bit 1 set.
    selectBackup(cart, true);
    exchange(cart, 0x05);
    expect(exchange(cart, 0x00) & 0x02).toBe(0x02);
    selectBackup(cart, false);
    // WRITE 0x12 0x34 0x56 at addr 0x000010.
    selectBackup(cart, true);
    exchange(cart, 0x02);
    exchange(cart, 0x00); exchange(cart, 0x00); exchange(cart, 0x10);
    exchange(cart, 0x12); exchange(cart, 0x34); exchange(cart, 0x56);
    selectBackup(cart, false);
    expect(cart.savDirty).toBe(true);
    expect(cart.sav[0x10]).toBe(0x12);
    expect(cart.sav[0x11]).toBe(0x34);
    expect(cart.sav[0x12]).toBe(0x56);
  });

  it('READ streams what was written', () => {
    const cart = new Cart();
    cart.loadRom(new Uint8Array(0x10000));
    // Pre-stage save bytes.
    cart.sav[0x20] = 0xAA;
    cart.sav[0x21] = 0xBB;
    cart.sav[0x22] = 0xCC;
    selectBackup(cart, true);
    exchange(cart, 0x03);                    // READ
    exchange(cart, 0x00); exchange(cart, 0x00); exchange(cart, 0x20);   // addr
    expect(exchange(cart, 0x00)).toBe(0xAA);
    expect(exchange(cart, 0x00)).toBe(0xBB);
    expect(exchange(cart, 0x00)).toBe(0xCC);
    selectBackup(cart, false);
  });

  it('WRITE while not enabled is a no-op', () => {
    const cart = new Cart();
    cart.loadRom(new Uint8Array(0x10000));
    // No WREN — write should be dropped.
    selectBackup(cart, true);
    exchange(cart, 0x02);
    exchange(cart, 0x00); exchange(cart, 0x00); exchange(cart, 0x30);
    exchange(cart, 0xDE); exchange(cart, 0xAD);
    selectBackup(cart, false);
    expect(cart.sav[0x30]).toBe(0xFF);   // empty
    expect(cart.sav[0x31]).toBe(0xFF);
    expect(cart.savDirty).toBe(false);
  });

  it('WRDI clears WEL', () => {
    const cart = new Cart();
    cart.loadRom(new Uint8Array(0x10000));
    selectBackup(cart, true); exchange(cart, 0x06); selectBackup(cart, false);  // WREN
    selectBackup(cart, true); exchange(cart, 0x04); selectBackup(cart, false);  // WRDI
    selectBackup(cart, true);
    exchange(cart, 0x05);
    expect(exchange(cart, 0x00) & 0x02).toBe(0);
    selectBackup(cart, false);
  });

  it('RDID returns a JEDEC ID for chip detection', () => {
    const cart = new Cart();
    cart.loadRom(new Uint8Array(0x10000));
    selectBackup(cart, true);
    exchange(cart, 0x9F);
    expect(exchange(cart, 0x00)).toBe(0xC2);   // Macronix
    expect(exchange(cart, 0x00)).toBe(0x20);
    expect(exchange(cart, 0x00)).toBe(0x14);   // 1 MB class
    selectBackup(cart, false);
  });

  it('loadSav installs save data and clears dirty', () => {
    const cart = new Cart();
    cart.loadRom(new Uint8Array(0x10000));
    cart.sav[0x100] = 0x77;
    cart.savDirty = true;
    cart.loadSav(new Uint8Array([0x01, 0x02, 0x03]));
    expect(cart.sav[0]).toBe(0x01);
    expect(cart.sav[1]).toBe(0x02);
    expect(cart.sav[2]).toBe(0x03);
    expect(cart.sav[0x100]).toBe(0xFF);   // reset to empty
    expect(cart.savDirty).toBe(false);
  });
});
