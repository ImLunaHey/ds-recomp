import { describe, it, expect, beforeEach } from 'vitest';
import { Wifi } from '../io/wifi';
import { SharedMemory } from '../memory/shared';
import { Bus7 } from '../memory/bus7';

describe('Wifi register stubs', () => {
  let wifi: Wifi;
  beforeEach(() => { wifi = new Wifi(); });

  it('returns the DS WiFi chip ID 0x1440 at 0x0480000C', () => {
    expect(wifi.read16(0x0480000C)).toBe(0x1440);
  });

  it('reports ready (bit 9) after a 0x8001 write to W_POWER_STATE', () => {
    wifi.write16(0x04800040, 0x8001);
    const v = wifi.read16(0x04800040);
    expect(v & (1 << 9)).not.toBe(0);
  });

  it('clears the ready bit after a W_POWER_DOWN write', () => {
    wifi.write16(0x04800040, 0x8001);
    expect(wifi.read16(0x04800040) & (1 << 9)).not.toBe(0);
    wifi.write16(0x0480003C, 0x0001);
    expect(wifi.read16(0x04800040) & (1 << 9)).toBe(0);
  });

  it('baseband regs read 0xFF by default (chip-reset state)', () => {
    // Direct BB read: write BB_CNT with address 0x05 and read direction.
    wifi.write16(0x04800158, 0x0005);
    expect(wifi.read16(0x0480015C)).toBe(0xFF);
  });

  it('baseband write-then-read round-trip', () => {
    // Latch data into W_BB_WRITE, then strobe W_BB_CNT with write bit.
    wifi.write16(0x0480015A, 0x00AB);
    wifi.write16(0x04800158, 0x1010);   // bit 12 = write, addr = 0x10
    // Now switch to read direction and check it came back.
    wifi.write16(0x04800158, 0x0010);   // addr = 0x10, read
    expect(wifi.read16(0x0480015C)).toBe(0xAB);
  });

  it('TX buffer write-data advances the wr-addr pointer', () => {
    wifi.write16(0x04800068, 0x0000);   // W_TXBUF_WR_ADDR = 0
    wifi.write16(0x04800070, 0xDEAD);   // W_TXBUF_WR_DATA
    expect(wifi.read16(0x04800068)).toBe(0x0002);
    wifi.write16(0x04800070, 0xBEEF);
    expect(wifi.read16(0x04800068)).toBe(0x0004);
  });

  it('generic register round-trips via the 32 KB shadow', () => {
    wifi.write16(0x04800100, 0x1234);
    expect(wifi.read16(0x04800100)).toBe(0x1234);
  });

  it('8-bit reads decompose a 16-bit register', () => {
    wifi.write16(0x04800100, 0xABCD);
    expect(wifi.read8(0x04800100)).toBe(0xCD);
    expect(wifi.read8(0x04800101)).toBe(0xAB);
  });

  it('32-bit accesses split into two halfwords', () => {
    wifi.write32(0x04800200, 0xCAFEBABE);
    expect(wifi.read32(0x04800200) >>> 0).toBe(0xCAFEBABE);
    expect(wifi.read16(0x04800200)).toBe(0xBABE);
    expect(wifi.read16(0x04800202)).toBe(0xCAFE);
  });
});

describe('Bus7 routes WiFi MMIO to Wifi stub', () => {
  let bus: Bus7;
  let wifi: Wifi;
  beforeEach(() => {
    bus = new Bus7(new SharedMemory());
    wifi = new Wifi();
    bus.attachWifi(wifi);
  });

  it('reads WIFI chip-ID through the bus', () => {
    expect(bus.read16(0x0480000C)).toBe(0x1440);
  });

  it('writes to W_POWER_STATE through the bus latch the ready bit', () => {
    bus.write16(0x04800040, 0x8001);
    expect(bus.read16(0x04800040) & (1 << 9)).not.toBe(0);
  });

  it('addresses outside the WIFI window are NOT routed to the stub', () => {
    // 0x04808000 is past WIFI_END — write should not land in wifi.io.
    bus.write16(0x04808000, 0x1234);
    expect(wifi.read16(0x04800000)).toBe(0);
  });
});
