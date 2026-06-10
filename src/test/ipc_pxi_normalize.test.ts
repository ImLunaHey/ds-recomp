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

    it('leaves SYSTEM-tag (0x00) replies untouched — bit 5 is meaningful', () => {
      // Nintendogs sends 0x00040005 and ARM7 replies 0x00040025; the
      // bit-5 difference is the *completion signal*, not a stale busy
      // indicator. Stripping it makes the reply look like an echo of
      // the original command and ARM9's PXI dispatcher silently drops
      // it — Nintendogs then deadlocks on its "wait for flag clear"
      // stub at 0x02077f64 because the callback that would clear the
      // flag never fires. Pokemon Platinum's SYSTEM-tag replies
      // (0x00240005 / 0x00244005 / 0x00248005) and the various
      // heartbeat ticks (0x0000006B / 0x000001AB) all carry bit 5
      // only in upper bytes, so leaving the SYSTEM tag alone is safe
      // across captured ROMs.
      expect(normalizePxiReply(0x00040025)).toBe(0x00040025);
      expect(normalizePxiReply(0x00040005)).toBe(0x00040005);
      expect(normalizePxiReply(0x00240005)).toBe(0x00240005);
      expect(normalizePxiReply(0x00244005)).toBe(0x00244005);
      expect(normalizePxiReply(0x00248005)).toBe(0x00248005);
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
      // The system tag is now never normalized, so heartbeats pass
      // through unchanged trivially. Keep the test so regressions in
      // the tag-table (e.g. re-adding 0x00) get caught immediately.
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
      // The 0x00 (SYSTEM) tag is now a full passthrough — verify a
      // payload-full input is returned unchanged.
      const sysReply = (0x00FFFFFF) >>> 0;
      expect(normalizePxiReply(sysReply)).toBe(0x00FFFFFF);
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

    it('passes ARM7→ARM9 SYSTEM (0x00) replies through unmodified', () => {
      // Nintendogs' completion signal is bit 5 of the reply low byte,
      // so the bus must not strip it.
      ipc.writeSend(false, 0x00040025);
      expect(ipc.readRecv(true) >>> 0).toBe(0x00040025);
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
