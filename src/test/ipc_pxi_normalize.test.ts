import { describe, it, expect, beforeEach } from 'vitest';
import { Ipc, normalizePxiReply } from '../io/ipc';
import { Irq } from '../io/irq';

describe('PXI reply normalization', () => {
  describe('normalizePxiReply (pure helper)', () => {
    it('strips bit 21 from SND-tag (0xC0) replies — SNDi NG bit', () => {
      // Tetris DS / Pokemon Platinum SNDi init reply pattern: 0xc0280004 → 0xc0080004.
      expect(normalizePxiReply(0xC0280004)).toBe(0xC0080004);
      expect(normalizePxiReply(0xC0288004)).toBe(0xC0088004);
    });

    it('strips bit 5 from SYSTEM-tag (0x00) replies — Nintendogs busy bit', () => {
      // Nintendogs hammers 0x00040005 / 0x00040025 every frame.
      expect(normalizePxiReply(0x00040025)).toBe(0x00040005);
    });

    it('strips bit 5 from WM-tag (0x40) and MIC-tag (0x80) replies', () => {
      // Pokemon Platinum early handshake had 0x40400068 and 0x801900a8.
      expect(normalizePxiReply(0x40400068)).toBe(0x40400048);
      expect(normalizePxiReply(0x801900A8)).toBe(0x80190088);
    });

    it('leaves unknown tags untouched', () => {
      // Tag 0x12 isn't in our table — passthrough.
      expect(normalizePxiReply(0x12345678)).toBe(0x12345678);
      // Tags 0x01..0x3F, 0x41..0x7F, 0x81..0xBF, 0xC1..0xFF all
      // bypass normalization.
      expect(normalizePxiReply(0xAB123456)).toBe(0xAB123456);
      expect(normalizePxiReply(0x7F123456)).toBe(0x7F123456);
    });

    it('preserves the system-tag heartbeat tick (Pokemon 0x6b/0x1ab)', () => {
      // Both heartbeat values have bit 5 set in their low byte but
      // empty upper-payload — the guard should keep them intact.
      expect(normalizePxiReply(0x0000006B)).toBe(0x0000006B);
      expect(normalizePxiReply(0x000001AB)).toBe(0x000001AB);
    });

    it('is idempotent on already-clean replies', () => {
      expect(normalizePxiReply(0xC0080004)).toBe(0xC0080004);
      expect(normalizePxiReply(0x00040005)).toBe(0x00040005);
    });

    it('only touches the documented busy bit, not the rest of the payload', () => {
      // Set every bit except the busy bits we strip. Result should
      // differ from input only in the documented mask position.
      const sndReply = (0xC0FFFFFF) >>> 0;
      expect(normalizePxiReply(sndReply)).toBe((0xC0DFFFFF) >>> 0);   // bit 21 cleared
      const sysReply = (0x00FFFFFF) >>> 0;
      expect(normalizePxiReply(sysReply)).toBe((0x00FFFFDF) >>> 0);   // bit 5 cleared
    });
  });

  describe('Ipc.writeSend integration — ARM7→ARM9 path only', () => {
    const ENABLE_BIT = 1 << 15;
    let irq9: Irq, irq7: Irq, ipc: Ipc;
    beforeEach(() => {
      irq9 = new Irq();
      irq7 = new Irq();
      ipc = new Ipc(irq9, irq7);
      ipc.writeCnt(true, ENABLE_BIT);
      ipc.writeCnt(false, ENABLE_BIT);
    });

    it('normalizes ARM7→ARM9 SND reply (0xC0 / bit 21)', () => {
      ipc.writeSend(false, 0xC0280004);
      expect(ipc.readRecv(true) >>> 0).toBe(0xC0080004);
    });

    it('normalizes ARM7→ARM9 SYSTEM reply (0x00 / bit 5)', () => {
      ipc.writeSend(false, 0x00040025);
      expect(ipc.readRecv(true) >>> 0).toBe(0x00040005);
    });

    it('normalizes ARM7→ARM9 WM reply (0x40 / bit 5)', () => {
      ipc.writeSend(false, 0x40400068);
      expect(ipc.readRecv(true) >>> 0).toBe(0x40400048);
    });

    it('normalizes ARM7→ARM9 MIC reply (0x80 / bit 5)', () => {
      ipc.writeSend(false, 0x801900A8);
      expect(ipc.readRecv(true) >>> 0).toBe(0x80190088);
    });

    it('does NOT normalize ARM9→ARM7 sends — commands keep their bits', () => {
      // ARM9 commands often have payload bits that happen to overlap
      // our reply-busy bits. Stripping them on the outgoing direction
      // would corrupt the command. Verify ARM7 receives the exact word.
      ipc.writeSend(true, 0xC0280004);
      expect(ipc.readRecv(false) >>> 0).toBe(0xC0280004);
      ipc.writeSend(true, 0x00040025);
      expect(ipc.readRecv(false) >>> 0).toBe(0x00040025);
    });

    it('leaves replies with unknown tags untouched', () => {
      ipc.writeSend(false, 0x12345678);
      expect(ipc.readRecv(true) >>> 0).toBe(0x12345678);
    });
  });
});
