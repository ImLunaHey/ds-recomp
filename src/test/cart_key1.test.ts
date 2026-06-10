import { describe, it, expect } from 'vitest';
import { Cart } from '../cart/cart';

function makeRom(): Uint8Array {
  // 256 KB fake ROM with header + secure-area area pre-filled.
  const r = new Uint8Array(256 * 1024);
  // Header: arbitrary marker bytes; cart returns first 0x200 for cmd 0x00.
  for (let i = 0; i < 0x200; i++) r[i] = (i + 1) & 0xFF;
  // Secure area 0x4000-0x7FFF: distinctive pattern.
  for (let i = 0x4000; i < 0x8000; i++) r[i] = (i & 0xFF) ^ 0xAA;
  return r;
}

function loadAndSend(cart: Cart, cmd0: number, blockSize = 0x200): Uint8Array {
  cart.cmd.fill(0);
  cart.cmd[0] = cmd0;
  // ROMCTRL: block-size index 1 (= 0x200), start bit 31.
  cart.writeRomCtrl(0x01_000000 | (1 << 31));
  // Drain.
  const out = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 4) {
    const v = cart.readRomData();
    out[i]     =  v        & 0xFF;
    out[i + 1] = (v >>>  8) & 0xFF;
    out[i + 2] = (v >>> 16) & 0xFF;
    out[i + 3] = (v >>> 24) & 0xFF;
  }
  return out;
}

describe('Cart KEY1/KEY2 protocol', () => {
  it('starts in RAW phase and handles dummy cmd 0x9F', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    const out = loadAndSend(cart, 0x9F);
    expect(out.every((b) => b === 0xFF)).toBe(true);
  });

  it('cmd 0x00 streams the header', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    const out = loadAndSend(cart, 0x00);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(2);
    expect(out[0x10]).toBe(0x11);
  });

  it('cmd 0x90 returns the chip ID (4-byte repeating)', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    const out = loadAndSend(cart, 0x90);
    // Manufacturer Macronix = 0xC2 in byte 0.
    expect(out[0]).toBe(0xC2);
    expect(out[4]).toBe(0xC2);   // repeating
  });

  it('cmd 0x3C transitions to KEY1 phase', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    loadAndSend(cart, 0x3C);
    expect(cart.phase).toBe(1);     // PHASE_KEY1
  });

  it('first KEY1 command returns chip ID', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    loadAndSend(cart, 0x3C);
    // First KEY1 cmd (any cmd0 byte is OK since we ignore it).
    const out = loadAndSend(cart, 0x00);
    expect(out[0]).toBe(0xC2);
  });

  it('subsequent KEY1 commands stream the secure area (ROM 0x4000+)', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    loadAndSend(cart, 0x3C);
    loadAndSend(cart, 0x00);       // KEY1 #1 = chip ID
    const out = loadAndSend(cart, 0x00);    // KEY1 #2 = secure area block 0
    // Byte 0 of secure area = (0x4000 & 0xFF) ^ 0xAA = 0x00 ^ 0xAA = 0xAA.
    expect(out[0]).toBe(0xAA);
    expect(out[1]).toBe((0x01) ^ 0xAA);
  });

  it('after ~6 KEY1 commands, transitions to KEY2', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    loadAndSend(cart, 0x3C);
    for (let i = 0; i < 6; i++) loadAndSend(cart, 0x00);
    expect(cart.phase).toBe(2);     // PHASE_KEY2
  });

  it('KEY2 cmd 0xB7 streams addressed data from the ROM', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    // Walk through to KEY2.
    loadAndSend(cart, 0x3C);
    for (let i = 0; i < 6; i++) loadAndSend(cart, 0x00);
    // Now in KEY2. 0xB7 with address 0x10000.
    cart.cmd.fill(0);
    cart.cmd[0] = 0xB7;
    cart.cmd[1] = 0x00; cart.cmd[2] = 0x01; cart.cmd[3] = 0x00; cart.cmd[4] = 0x00;
    cart.writeRomCtrl(0x01_000000 | (1 << 31));
    const v = cart.readRomData();
    // ROM byte 0x10000 wasn't set explicitly so it's 0; first word = 0.
    expect(v).toBe(0);
  });

  it('onTransferReady fires after startTransfer', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    let fired = 0;
    cart.onTransferReady = () => fired++;
    loadAndSend(cart, 0x9F);
    expect(fired).toBeGreaterThan(0);
  });

  it('onTransferEnd fires after last word read, but only with AUXSPICNT bit 14 set', () => {
    const cart = new Cart();
    cart.loadRom(makeRom());
    let fired = 0;
    cart.onTransferEnd = () => fired++;
    // First without bit 14.
    cart.writeAuxSpiCnt(0);
    loadAndSend(cart, 0x9F);
    expect(fired).toBe(0);
    // Now with bit 14 (= 0x4000).
    cart.writeAuxSpiCnt(0x4000);
    loadAndSend(cart, 0x9F);
    expect(fired).toBeGreaterThan(0);
  });
});
