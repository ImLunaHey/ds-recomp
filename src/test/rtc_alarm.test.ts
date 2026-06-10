// RTC alarm / clock-adjust / free-register persistence tests.
//
// Drives the bit-banged 3-wire serial port on 0x04000138 directly,
// confirming a write transaction (cmd byte 0x00) followed by a read
// (cmd byte 0x80) round-trips the bytes via the Seiko S3511 register
// map (commands 4..7) defined by GBATEK §"DS Real Time Clock".

import { describe, it, expect } from 'vitest';
import { Rtc } from '../io/rtc';

// Bit positions on 0x04000138.
const SEL  = 1 << 2;
const CLK  = 1 << 1;
const DIRD = 1 << 4; // DATA direction: 1 = ARM7 → RTC
const DIRC = 1 << 5; // CLK  direction
const DIRS = 1 << 6; // SEL  direction
const ALL_DIRS = DIRD | DIRC | DIRS;

// Begin a transaction: SEL rising edge (CLK low, all directions out).
function selectChip(rtc: Rtc): void {
  rtc.write(ALL_DIRS | 0);       // SEL low, CLK low
  rtc.write(ALL_DIRS | SEL);     // SEL high, CLK low — rising edge
}

// End a transaction: SEL falling edge with CLK low.
function deselectChip(rtc: Rtc): void {
  rtc.write(ALL_DIRS | 0);
}

// Shift one bit MSB-first into the chip: CLK low → CLK high while
// holding `bit` on DATA. The chip latches on the CLK rising edge.
function shiftBitIn(rtc: Rtc, bit: number): void {
  rtc.write(ALL_DIRS | SEL | (bit & 1));         // CLK low, data set
  rtc.write(ALL_DIRS | SEL | CLK | (bit & 1));   // CLK high — sampled
}

// Shift one bit out of the chip: DATA direction = 0 (RTC → ARM7).
// CLK low → CLK high, then read back bit 0 of the register.
function shiftBitOut(rtc: Rtc): number {
  const base = DIRC | DIRS; // DATA direction = input
  rtc.write(base | SEL);              // CLK low
  rtc.write(base | SEL | CLK);        // CLK high — chip drives bit 0
  return rtc.read() & 1;
}

function sendByte(rtc: Rtc, byte: number): void {
  for (let i = 7; i >= 0; i--) shiftBitIn(rtc, (byte >> i) & 1);
}

function recvByte(rtc: Rtc): number {
  let v = 0;
  for (let i = 0; i < 8; i++) v = (v << 1) | shiftBitOut(rtc);
  return v & 0xFF;
}

// Command byte: bit 7 R/W, bits 6-4 cmd index, bits 3-0 = 0110b sanity.
function cmdByte(cmdIdx: number, read: boolean): number {
  return ((read ? 0x80 : 0x00) | ((cmdIdx & 0x7) << 4) | 0x06) & 0xFF;
}

function writeReg(rtc: Rtc, cmdIdx: number, bytes: number[]): void {
  selectChip(rtc);
  sendByte(rtc, cmdByte(cmdIdx, false));
  for (const b of bytes) sendByte(rtc, b);
  deselectChip(rtc);
}

function readReg(rtc: Rtc, cmdIdx: number, count: number): number[] {
  selectChip(rtc);
  sendByte(rtc, cmdByte(cmdIdx, true));
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(recvByte(rtc));
  deselectChip(rtc);
  return out;
}

describe('RTC alarm / free / clk-adj persistence', () => {
  it('ALARM1 (cmd 4) round-trips 3 bytes', () => {
    const rtc = new Rtc();
    const payload = [0xC3, 0x91, 0x45]; // dow+enable, hour+pm, minute
    writeReg(rtc, 4, payload);
    const got = readReg(rtc, 4, 3);
    expect(got).toEqual(payload);
  });

  it('ALARM2 (cmd 5) round-trips 3 bytes and is independent of ALARM1', () => {
    const rtc = new Rtc();
    const a1 = [0x11, 0x22, 0x33];
    const a2 = [0xAA, 0xBB, 0xCC];
    writeReg(rtc, 4, a1);
    writeReg(rtc, 5, a2);
    expect(readReg(rtc, 4, 3)).toEqual(a1);
    expect(readReg(rtc, 5, 3)).toEqual(a2);
  });

  it('CLK_ADJ (cmd 6) round-trips 1 byte', () => {
    const rtc = new Rtc();
    writeReg(rtc, 6, [0x7F]);
    expect(readReg(rtc, 6, 1)).toEqual([0x7F]);
  });

  it('FREE (cmd 7) round-trips 1 byte', () => {
    const rtc = new Rtc();
    writeReg(rtc, 7, [0xA5]);
    expect(readReg(rtc, 7, 1)).toEqual([0xA5]);
    // Overwrite to confirm subsequent writes replace prior value.
    writeReg(rtc, 7, [0x5A]);
    expect(readReg(rtc, 7, 1)).toEqual([0x5A]);
  });

  it('STATUS1 (cmd 0) defaults with bit 1 (24-hr mode) set', () => {
    const rtc = new Rtc();
    expect(readReg(rtc, 0, 1)).toEqual([0x02]);
  });

  it('STATUS1 writes round-trip while 24-hr bit can be preserved by the writer', () => {
    const rtc = new Rtc();
    // Software typically reads, modifies, writes back. Set INT1E (bit 1
    // in many bring-ups doubles as 24-hr; here we just confirm the
    // chip echoes whatever the master stored, including the 24-hr bit).
    writeReg(rtc, 0, [0x42]); // bit 6 + 24-hr (bit 1)
    expect(readReg(rtc, 0, 1)).toEqual([0x42]);
  });

  it('STATUS2 (cmd 1) round-trips a written value', () => {
    const rtc = new Rtc();
    writeReg(rtc, 1, [0x55]);
    expect(readReg(rtc, 1, 1)).toEqual([0x55]);
  });

  it('DATE+TIME (cmd 2) still derives from the dateProvider after alarm writes', () => {
    // Regression: persisting alarm/free writes must not clobber the
    // live host-time path.
    const rtc = new Rtc();
    rtc.dateProvider = () => new Date(2026, 0, 2, 3, 4, 5);
    writeReg(rtc, 4, [0xDE, 0xAD, 0xBE]);
    const got = readReg(rtc, 2, 7);
    // BCD(year%100=26)=0x26, month=01, day=02, dow=Fri(5), 03:04:05 BCD.
    expect(got[0]).toBe(0x26);
    expect(got[1]).toBe(0x01);
    expect(got[2]).toBe(0x02);
    expect(got[4]).toBe(0x03);
    expect(got[5]).toBe(0x04);
    expect(got[6]).toBe(0x05);
  });
});
