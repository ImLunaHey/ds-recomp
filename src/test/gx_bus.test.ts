import { describe, it, expect } from 'vitest';
import { Emulator } from '../emulator';

// Drive GX through the IO bus path (write32 to 0x04000400) instead of
// calling gx.writeFifo directly — verifies the agent-wired GXFIFO
// routing actually delivers commands.

function packXY(x: number, y: number): number {
  const lo = (Math.round(x * 4096) & 0xFFFF);
  const hi = (Math.round(y * 4096) & 0xFFFF) << 16;
  return (lo | hi) >>> 0;
}

describe('GX via IO bus', () => {
  it('writes to 0x04000400 reach the GX engine and render', () => {
    const emu = new Emulator();
    const cmd = (op: number, ...params: number[]): void => {
      emu.bus9.write32(0x04000400, op);
      for (const p of params) emu.bus9.write32(0x04000400, p);
    };
    cmd(0x10, 0); cmd(0x15);
    cmd(0x10, 1); cmd(0x15);
    cmd(0x40, 0);
    cmd(0x20, 0x7C00);     // BGR555 blue
    cmd(0x23, packXY(-0.5, -0.5), Math.round(0 * 4096) & 0xFFFF);
    cmd(0x23, packXY( 0.5, -0.5), Math.round(0 * 4096) & 0xFFFF);
    cmd(0x23, packXY( 0.0,  0.5), Math.round(0 * 4096) & 0xFFFF);
    cmd(0x41);
    cmd(0x50, 0);
    const fb = emu.ppu.gx.fbFront;
    let drawn = 0;
    for (let i = 0; i < fb.length; i++) if ((fb[i] & 0x8000) !== 0) drawn++;
    expect(drawn).toBeGreaterThan(5000);
    expect(drawn).toBeLessThan(7000);
    // Confirm color is blue (BGR555 0x7C00).
    const colors = new Set<number>();
    for (let i = 0; i < fb.length; i++) {
      if ((fb[i] & 0x8000) !== 0) colors.add(fb[i] & 0x7FFF);
    }
    expect([...colors][0]).toBe(0x7C00);
  });
});
