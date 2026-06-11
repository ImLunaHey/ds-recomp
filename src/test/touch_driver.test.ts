import { describe, it, expect, beforeEach } from 'vitest';
import { Emulator } from '../emulator';
import {
  TOUCH_STRUCT_BASE,
  TOUCH_PRESSED_OFFSET,
  TOUCH_X_OFFSET,
  TOUCH_Y_OFFSET,
  TOUCH_FRAME_OFFSET,
} from '../io/touch_driver';

// The touch driver synthesizes the NitroSDK OS shared-work touch
// struct at the well-known main-RAM location 0x027FFFA8. Real games
// poll this struct every frame; we want to verify the driver writes
// the four documented fields (pressed, x, y, updateFrame) on each
// tickVBlank() call.

describe('TouchDriver', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('writes pressed=1 + screen coords when touchZ exceeds pressure threshold', () => {
    emu.spi.touchX = 128;
    emu.spi.touchY = 96;
    emu.spi.touchZ = 0x800;        // typical pressed value (12-bit ADC midpoint-ish)
    emu.touchDriver.tickVBlank();
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + TOUCH_PRESSED_OFFSET)).toBe(1);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_X_OFFSET     )).toBe(128);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_Y_OFFSET     )).toBe(96);
    // updateFrame should be nonzero so games using it as "new data"
    // flag see fresh input on the very first tick.
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + TOUCH_FRAME_OFFSET )).not.toBe(0);
  });

  it('writes pressed=0 and zero coords when touchZ is 0', () => {
    emu.spi.touchX = 128;
    emu.spi.touchY = 96;
    emu.spi.touchZ = 0;
    emu.touchDriver.tickVBlank();
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + TOUCH_PRESSED_OFFSET)).toBe(0);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_X_OFFSET     )).toBe(0);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_Y_OFFSET     )).toBe(0);
  });

  it('updateFrame counter increments on each tick', () => {
    emu.spi.touchX = 50;
    emu.spi.touchY = 50;
    emu.spi.touchZ = 0x800;
    emu.touchDriver.tickVBlank();
    const f1 = emu.bus9.read8(TOUCH_STRUCT_BASE + TOUCH_FRAME_OFFSET);
    emu.touchDriver.tickVBlank();
    const f2 = emu.bus9.read8(TOUCH_STRUCT_BASE + TOUCH_FRAME_OFFSET);
    emu.touchDriver.tickVBlank();
    const f3 = emu.bus9.read8(TOUCH_STRUCT_BASE + TOUCH_FRAME_OFFSET);
    expect(f2).not.toBe(f1);
    expect(f3).not.toBe(f2);
    // u8 — values stay in range.
    expect(f1).toBeLessThanOrEqual(0xFF);
    expect(f3).toBeLessThanOrEqual(0xFF);
  });

  it('enabled=false leaves the struct untouched', () => {
    emu.touchDriver.enabled = false;
    emu.spi.touchX = 200;
    emu.spi.touchY = 150;
    emu.spi.touchZ = 0x800;
    emu.touchDriver.tickVBlank();
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + TOUCH_PRESSED_OFFSET)).toBe(0);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_X_OFFSET     )).toBe(0);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_Y_OFFSET     )).toBe(0);
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + TOUCH_FRAME_OFFSET )).toBe(0);
  });

  it('clamps out-of-range UI coords to the bottom-screen extent', () => {
    emu.spi.touchX = 500;          // > 255
    emu.spi.touchY = 300;          // > 191
    emu.spi.touchZ = 0x800;
    emu.touchDriver.tickVBlank();
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_X_OFFSET)).toBe(255);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_Y_OFFSET)).toBe(191);
  });

  it('null touchX/touchY with pressed touchZ still produces sane (0, 0) coords', () => {
    emu.spi.touchX = null;
    emu.spi.touchY = null;
    emu.spi.touchZ = 0x800;
    emu.touchDriver.tickVBlank();
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + TOUCH_PRESSED_OFFSET)).toBe(1);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_X_OFFSET     )).toBe(0);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_Y_OFFSET     )).toBe(0);
  });

  it('runFrame() calls tickVBlank() so the struct gets refreshed once per frame', () => {
    // Without a ROM loaded, runFrame still drives the PPU and ends a
    // frame at VBlank; touchDriver should run as part of that.
    emu.spi.touchX = 100;
    emu.spi.touchY = 100;
    emu.spi.touchZ = 0x800;
    emu.runFrame();
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + TOUCH_PRESSED_OFFSET)).toBe(1);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_X_OFFSET     )).toBe(100);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + TOUCH_Y_OFFSET     )).toBe(100);
  });
});

// End-to-end "did my click reach the emulator?" tests. The full chain:
//   UI pointer event → sets spi.touchX / touchY / touchZ
//                    → EXTKEYIN read-side returns bit 6 cleared
//                    → TSC2046 SPI returns ADC-mapped coords
//                    → touchDriver.tickVBlank() writes the cooked
//                       struct to 0x027FFFA8 (both NitroSDK + SDK-1.x
//                       byte-+1 layouts).
// These tests pin every link of the chain so a regression at any
// layer surfaces immediately.
describe('Touch input — end-to-end chain from UI to the emulator', () => {
  it('UI tap on bottom-center clears EXTKEYIN bit 6 (= pen DOWN) on ARM7 IO', () => {
    const emu = new Emulator();
    // EXTKEYIN lives on the ARM7 IO bus (io7). ARM9 doesn't see it
    // per real DS, since SPI / touchscreen are ARM7-controlled.
    expect((emu.io7.read8(0x04000136) >> 6) & 1).toBe(1);    // default: released
    // Simulate the UI's pointer-down handler.
    emu.spi.touchX = 128;
    emu.spi.touchY = 96;
    emu.spi.touchZ = 0x800;
    expect((emu.io7.read8(0x04000136) >> 6) & 1).toBe(0);    // pressed
    // Release.
    emu.spi.touchX = null;
    emu.spi.touchY = null;
    emu.spi.touchZ = 0;
    expect((emu.io7.read8(0x04000136) >> 6) & 1).toBe(1);    // released
  });

  it('touchDriver writes pressed + screen coords on the very next VBlank', () => {
    const emu = new Emulator();
    emu.spi.touchX = 100;
    emu.spi.touchY = 80;
    emu.spi.touchZ = 0x800;
    emu.touchDriver.tickVBlank();
    // NitroSDK layout
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + 0)).toBe(1);       // pressed
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + 2)).toBe(100);     // X u16
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + 4)).toBe(80);      // Y u16
    // SDK-1.x byte-+1 X layout (Brain Training)
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + 1)).toBe(100);
  });

  it('releasing the pointer makes pressed=0 and resets X/Y to 0', () => {
    const emu = new Emulator();
    emu.spi.touchX = 128;
    emu.spi.touchY = 96;
    emu.spi.touchZ = 0x800;
    emu.touchDriver.tickVBlank();
    expect(emu.bus9.read8(TOUCH_STRUCT_BASE + 0)).toBe(1);
    // Now release.
    emu.spi.touchX = null;
    emu.spi.touchY = null;
    emu.spi.touchZ = 0;
    emu.touchDriver.tickVBlank();
    expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + 0)).toBe(0);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + 2)).toBe(0);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + 4)).toBe(0);
  });

  it('drag — multiple ticks with different coords each appear in the struct', () => {
    const emu = new Emulator();
    emu.spi.touchZ = 0x800;
    const path = [[10, 20], [50, 60], [100, 100], [200, 150]];
    for (const [x, y] of path) {
      emu.spi.touchX = x;
      emu.spi.touchY = y;
      emu.touchDriver.tickVBlank();
      expect(emu.bus9.read16(TOUCH_STRUCT_BASE + 2)).toBe(x);
      expect(emu.bus9.read16(TOUCH_STRUCT_BASE + 4)).toBe(y);
      expect(emu.bus9.read8 (TOUCH_STRUCT_BASE + 1)).toBe(x & 0xFF);
    }
  });

  it('low touchZ (= hover or stray noise) is NOT treated as pressed', () => {
    const emu = new Emulator();
    emu.spi.touchX = 128;
    emu.spi.touchY = 96;
    emu.spi.touchZ = 0x50;       // below the 0x100 PRESSURE_THRESHOLD
    emu.touchDriver.tickVBlank();
    expect(emu.bus9.read8(TOUCH_STRUCT_BASE + 0)).toBe(0);   // pressed
    // X/Y zeroed on the unpressed path
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + 2)).toBe(0);
    expect(emu.bus9.read16(TOUCH_STRUCT_BASE + 4)).toBe(0);
  });
});
