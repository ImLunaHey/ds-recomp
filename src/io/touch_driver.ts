// Synthesizes the cooked NitroSDK touch sample into the OS shared-work
// region in main RAM once per VBlank. On real hardware this work is
// done by the ARM7 touch task: every VBlank it issues four TSC2046 SPI
// reads (X / Y / Z1 / Z2), averages a few samples, applies the firmware
// calibration block, and ships the cooked (x, y, pressed) over PXI to
// ARM9. ARM9's touch service task then copies the cooked sample into a
// fixed struct near the end of main RAM, and games poll that struct.
//
// We don't have a complete ARM7 PXI roundtrip (the PXI stub server
// returns "command complete" with no payload), so games that wait on
// the touch-update wakeup never see a nonzero (x, y, pressed) and stay
// stuck on title screens that say "press to continue" (Brain Training,
// Cooking Mama, Pokemon Mystery Dungeon, AoE, Spider-Man, Simpsons).
//
// Approach: skip the ARM7 leg entirely. Once per VBlank, read the
// already-cooked pixel coords / pressure latch from `Spi` (the UI
// sets touchX/touchY on pointer events and touchZ to a sensible
// 12-bit pressure value, 0 when not pressed) and write the cooked
// sample directly into the standard NitroSDK PadStat-style touch
// struct at 0x027FFFA8.
//
// Struct layout (per NitroSDK `OS_PSWi` / `PadStat`-for-touch — see
// e.g. NitroSDK header `nitro/os/common/system.h` "OSTouchPanelStatus"
// and the layout used by melonDS's HLE touch service):
//   +0x00 (= 0x027FFFA8): u8  pressed      (1 = pen down, 0 = up)
//   +0x01 (= 0x027FFFA9): u8  reserved
//   +0x02 (= 0x027FFFAA): u16 x            (0..255 screen px)
//   +0x04 (= 0x027FFFAC): u16 y            (0..191 screen px)
//   +0x06 (= 0x027FFFAE): u8  updateFrame  (incrementing nonzero u8;
//                                            games sometimes use it as
//                                            a "new data arrived" flag)
//   +0x07 (= 0x027FFFAF): u8  reserved
//
// Games that read a different layout (e.g. homebrew, very-early SDK)
// won't be helped by this and may need a different driver — the
// `enabled` flag lets us turn this off if it ever causes a regression.

import type { Emulator } from '../emulator';

// Exported so tests (and any future debug overlay) can refer to the
// same constants without hard-coding hex.
export const TOUCH_STRUCT_BASE      = 0x027FFFA8;
export const TOUCH_PRESSED_OFFSET   = 0x00;
export const TOUCH_X_OFFSET         = 0x02;
export const TOUCH_Y_OFFSET         = 0x04;
export const TOUCH_FRAME_OFFSET     = 0x06;

// Pressure threshold for "pen down". The UI writes 0 for "released"
// and a 12-bit value (typically around 0x800) for "pressed". Anything
// above ~0x100 is treated as pressed — generous enough to accept any
// sane UI value without triggering on stray ADC noise but well below
// the typical pressed value of 0x800.
const PRESSURE_THRESHOLD = 0x100;

export class TouchDriver {
  enabled = true;

  // Incrementing counter for the "new data" byte at +0x06. Games may
  // treat 0 as "no sample ever arrived", so we bump BEFORE writing —
  // the first tick stamps 1. We also skip 0 on wrap-around for the
  // same reason.
  private updateFrame = 0;

  constructor(private emu: Emulator) {}

  // Call once per VBlank, AFTER the VBlank IRQ has been raised. On real
  // hardware the ARM7 touch task runs at high priority during VBlank
  // and ships the cooked sample to ARM9 over PXI; the order here
  // mirrors that timing (the struct is updated before games sample
  // it in their main loop, which typically waits on VBlank).
  tickVBlank(): void {
    if (!this.enabled) return;
    const spi = this.emu.spi;
    const bus9 = this.emu.bus9;

    // Read raw cooked sample from the SPI pointer latches. touchX/Y
    // are nullable (null = "released by UI"); touchZ is the pressure
    // latch (0 = released, ~0x800 = pressed).
    const x = spi.touchX ?? 0;
    const y = spi.touchY ?? 0;
    const z = spi.touchZ;
    const pressed = z > PRESSURE_THRESHOLD ? 1 : 0;

    // Clamp to screen-space ranges so a stray UI value can't write
    // garbage into the u16 fields. The bottom screen is 256x192.
    // When released, X/Y are zeroed — games sometimes use (0, 0) as
    // a "no contact" sentinel alongside pressed = 0.
    const sx = pressed ? Math.max(0, Math.min(255, x | 0)) : 0;
    const sy = pressed ? Math.max(0, Math.min(191, y | 0)) : 0;

    // Wrap to nonzero u8. Staying nonzero matches what a real touch
    // task does once the first sample has shipped.
    this.updateFrame = (this.updateFrame + 1) & 0xFF;
    if (this.updateFrame === 0) this.updateFrame = 1;

    // Write via bus9 so any DMA-watching / debug hooks see it. The
    // struct lives entirely in main RAM (region 0x02000000-0x023FFFFF
    // physical; 0x027FFFA8 lands in the 4MB-mirror at the top of the
    // canonical 0x027FFFxx OS shared-work area).
    bus9.write8 (TOUCH_STRUCT_BASE + TOUCH_PRESSED_OFFSET, pressed);
    bus9.write16(TOUCH_STRUCT_BASE + TOUCH_X_OFFSET,       sx);
    bus9.write16(TOUCH_STRUCT_BASE + TOUCH_Y_OFFSET,       sy);
    bus9.write8 (TOUCH_STRUCT_BASE + TOUCH_FRAME_OFFSET,   this.updateFrame);
    // Brain Training (DS Training, game code ANDP — an SDK 1.x launch
    // title) reads the screen X coordinate as a single byte at +1 of
    // the struct, rather than the u16-at-+2 the NitroSDK layout uses.
    // Setting just byte +1 to a valid X (e.g. 0x80 = 128) is what
    // advances its language-select state machine. We don't also write
    // Y at +3 because that would overwrite the X u16 high byte at +3
    // (low byte of X u16 is at +2) — breaking games that read the
    // NitroSDK layout. Brain Training appears to be content with X
    // alone; Y is likely read from elsewhere or not gated on.
    bus9.write8(TOUCH_STRUCT_BASE + 0x01, sx & 0xFF);
  }
}
