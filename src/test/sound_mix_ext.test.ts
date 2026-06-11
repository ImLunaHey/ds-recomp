// Extra Sound chip tests targeting the lower-coverage branches in
// sound.ts: PSG / ADPCM placeholders, channelSampleCount /
// channelLoopStart conversions per format, master-mute regardless of
// channels, and sample resolution from ARM7 IWRAM.

import { describe, it, expect, beforeEach } from 'vitest';
import { Sound } from '../io/sound';
import type { SoundMemory } from '../io/sound';

function makeMem(samples: Uint8Array, off = 0, target: 'main' | 'iwram' = 'main'): SoundMemory {
  const ram = new Uint8Array(64 * 1024);
  const iwram = new Uint8Array(64 * 1024);
  if (target === 'main') ram.set(samples, off);
  else iwram.set(samples, off);
  return { mainRam: ram, arm7Iwram: iwram };
}

// SOUNDCNT layout: bits 0..6 = master vol, bit 15 = enable.
function enableMaster(sound: Sound): void { sound.soundcnt = 0x8000 | 0x7F; }

// cnt bit layout (per GBATEK §"NDS Sound"):
//   bits 0..6    vol
//   bits 16..22  pan
//   bits 27..28  repeat
//   bits 29..30  format
//   bit 31       key-on
function buildCnt(opts: { vol: number; pan: number; fmt: number; repeat: number }): number {
  return (
    (opts.vol & 0x7F)
    | ((opts.pan & 0x7F) << 16)
    | ((opts.repeat & 0x3) << 27)
    | ((opts.fmt & 0x3) << 29)
    | (1 << 31)
  ) >>> 0;
}

function startChannel(sound: Sound, idx: number, opts: {
  vol: number; pan: number; fmt: number; repeat: number;
  sad: number; tmr: number; lenHalfwords: number;
}): void {
  const c = sound.channels[idx];
  c.sad = opts.sad >>> 0;
  c.tmr = opts.tmr & 0xFFFF;
  c.len = opts.lenHalfwords >>> 0;
  c.pnt = 0;
  c.cnt = buildCnt(opts);
  c.cyclesLeft = (0x10000 - c.tmr) * c.len;
  c.posFrac = 0;
}

describe('Sound — PSG / ADPCM placeholders', () => {
  let sound: Sound;
  beforeEach(() => { sound = new Sound(); enableMaster(sound); });

  it('PSG-format channel produces silence (placeholder)', () => {
    // Even with key-on + a populated source region, mix() skips fmt=3.
    const payload = new Uint8Array([0x40, 0x40, 0x40, 0x40]);
    sound.mem = makeMem(payload);
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 3,           // PSG
      repeat: 2, sad: 0x02000000, tmr: 0xF000,
      lenHalfwords: 4,
    });
    const out = sound.mix(8, 32000);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('ADPCM-format channel produces silence (placeholder)', () => {
    const payload = new Uint8Array([0x40, 0x40, 0x40, 0x40]);
    sound.mem = makeMem(payload);
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 2,           // ADPCM
      repeat: 2, sad: 0x02000000, tmr: 0xF000,
      lenHalfwords: 4,
    });
    const out = sound.mix(8, 32000);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });
});

describe('Sound — step() one-shot vs loop', () => {
  let sound: Sound;
  beforeEach(() => { sound = new Sound(); enableMaster(sound); });

  it('step() clears key-on bit when one-shot channel runs out of cycles', () => {
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 0,
      repeat: 2, sad: 0x02000000, tmr: 0xF000, lenHalfwords: 1,
    });
    // cyclesLeft was set during startChannel above; consume them all.
    const c = sound.channels[0];
    expect((c.cnt >>> 31) & 1).toBe(1);
    sound.step(c.cyclesLeft + 10);
    // Key-on bit must have been cleared (one-shot finished).
    expect((c.cnt >>> 31) & 1).toBe(0);
  });

  it('step() re-primes cycles when repeat = 1 (looping)', () => {
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 0,
      repeat: 1, sad: 0x02000000, tmr: 0xF000, lenHalfwords: 1,
    });
    const c = sound.channels[0];
    const initial = c.cyclesLeft;
    expect(initial).toBeGreaterThan(0);
    // Consume all cycles + a bit more.
    sound.step(initial + 1);
    // Loop should have re-primed cyclesLeft and kept key-on.
    expect((c.cnt >>> 31) & 1).toBe(1);
    expect(c.cyclesLeft).toBeGreaterThan(0);
  });
});

describe('Sound — sample resolution in ARM7 IWRAM', () => {
  it('resolves a PCM8 sample whose SAD lies in 0x037F8000..0x0380FFFF (ARM7 IWRAM)', () => {
    const sound = new Sound();
    enableMaster(sound);
    // Place a single +0.5 sample at IWRAM offset 0; SAD points at IWRAM
    // base 0x037F8000.
    const payload = new Uint8Array([0x40]);
    sound.mem = makeMem(payload, 0, 'iwram');
    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 0,
      repeat: 2, sad: 0x037F8000, tmr,
      lenHalfwords: 1,                      // 1 halfword = 2 PCM8 bytes
    });
    const out = sound.mix(1, OUTPUT_RATE);
    // The IWRAM resolver returned a real value, so out[0] is non-zero.
    expect(out[0]).not.toBe(0);
    expect(Math.abs(out[0])).toBeLessThan(1);
  });
});

describe('Sound — master mute with channels active', () => {
  it('SOUNDCNT bit 15 cleared yields all-zero output even if channels are key-on', () => {
    const sound = new Sound();
    sound.soundcnt = 0x7F;     // vol = max, enable = 0
    const payload = new Uint8Array([0x40, 0x40, 0x40, 0x40]);
    sound.mem = makeMem(payload);
    // Multiple key-on channels — all should be muted by the master.
    for (let i = 0; i < 4; i++) {
      startChannel(sound, i, {
        vol: 127, pan: 64, fmt: 0,
        repeat: 2, sad: 0x02000000, tmr: 0xF000,
        lenHalfwords: 2,
      });
    }
    const out = sound.mix(16, 32000);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });
});

describe('Sound — format conversion of length / loop fields', () => {
  // We can't reach the private channelSampleCount/channelLoopStart
  // helpers directly, but their behavior is observable via mix(): a
  // one-shot channel walks `channelSampleCount` source samples before
  // cutting off. PCM16 with len=N halfwords plays N samples; PCM8 with
  // len=N halfwords plays N*2 samples. Loop start with PCM8 doubles to
  // bytes.

  it('PCM16 length-1 plays exactly 1 source sample before silence (one-shot)', () => {
    const sound = new Sound();
    enableMaster(sound);
    // Two PCM16 samples in main RAM at SAD; len=1 halfword = 1 sample.
    const payload = new Uint8Array([0x00, 0x40, 0xFF, 0xFF]);
    sound.mem = makeMem(payload);
    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 1, repeat: 2, sad: 0x02000000, tmr,
      lenHalfwords: 1,
    });
    const out = sound.mix(4, OUTPUT_RATE);
    // First output sample has real signal (decoded 0x4000 = +0.5).
    expect(out[0]).not.toBe(0);
    // Subsequent samples are silence (one-shot ended).
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(0);
    expect(out[4]).toBe(0);
  });

  it('PCM8 length-1 plays exactly 2 source samples before silence (one-shot)', () => {
    const sound = new Sound();
    enableMaster(sound);
    const payload = new Uint8Array([0x40, 0x40, 0xFF, 0xFF]);
    sound.mem = makeMem(payload);
    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 0, repeat: 2, sad: 0x02000000, tmr,
      lenHalfwords: 1,                      // 1 halfword = 2 PCM8 bytes
    });
    const out = sound.mix(6, OUTPUT_RATE);
    // First two output samples non-zero, then silence.
    expect(out[0]).not.toBe(0);
    expect(out[2]).not.toBe(0);
    expect(out[4]).toBe(0);
    expect(out[6]).toBe(0);
    expect(out[8]).toBe(0);
  });
});

describe('Sound — looping with loop-point (repeat = 1)', () => {
  it('PCM8 looping channel wraps to loop-point (pnt halfwords → 2*bytes) when the cursor passes the end', () => {
    const sound = new Sound();
    enableMaster(sound);
    // 4-byte PCM8 source: A B C D. Loop point pnt = 1 halfword = 2 bytes.
    // After cursor walks past sample 4, it should wrap to sample 2 (loop start).
    const payload = new Uint8Array([0x40, 0x60, 0x20, 0x10]);
    sound.mem = makeMem(payload);
    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    const c = sound.channels[0];
    c.sad = 0x02000000;
    c.tmr = tmr & 0xFFFF;
    c.len = 2;                              // 2 halfwords = 4 PCM8 bytes
    c.pnt = 1;                              // loop at halfword 1 = byte 2
    c.cnt = (
      (127 & 0x7F)
      | ((64 & 0x7F) << 16)
      | ((1 & 0x3) << 27)                   // repeat = 1 (loop)
      // fmt = PCM8 (0); intentionally omitted
      | (1 << 31)
    ) >>> 0;
    c.cyclesLeft = (0x10000 - c.tmr) * c.len;
    c.posFrac = 0;
    // Output 8 samples — after sample 4 the cursor wraps to byte 2 (0x20),
    // emitting 0x20/128 next, then 0x10/128, then loops back to 0x20 etc.
    const out = sound.mix(8, OUTPUT_RATE);
    // First 4 outputs reflect bytes 0..3 (signed). Sample 4 should be
    // the loop-start byte (0x20) — non-zero, and key-on still 1.
    expect((c.cnt >>> 31) & 1).toBe(1);
    // Sample 4 (L channel) should not be zero (we're in the loop).
    expect(out[4 * 2]).not.toBe(0);
    // The looping branch must have executed (lines 307-310 covered).
  });

  it('PCM16 looping channel with loop-point at 0 wraps to start', () => {
    const sound = new Sound();
    enableMaster(sound);
    // 4 PCM16 samples (8 bytes). loop-point pnt = 0 (wrap to start).
    const payload = new Uint8Array([
      0x00, 0x40,   // sample 0 = +16384
      0x00, 0x20,   // sample 1 = +8192
      0x00, 0x10,   // sample 2 = +4096
      0x00, 0x08,   // sample 3 = +2048
    ]);
    sound.mem = makeMem(payload);
    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    const c = sound.channels[0];
    c.sad = 0x02000000;
    c.tmr = tmr & 0xFFFF;
    c.len = 4;                              // 4 halfwords = 4 PCM16 samples
    c.pnt = 0;                              // loop at start
    c.cnt = (
      (127 & 0x7F)
      | ((64 & 0x7F) << 16)
      | ((1 & 0x3) << 27)                   // repeat = 1
      | ((1 & 0x3) << 29)                   // fmt = PCM16
      | (1 << 31)
    ) >>> 0;
    c.cyclesLeft = (0x10000 - c.tmr) * c.len;
    c.posFrac = 0;
    const out = sound.mix(8, OUTPUT_RATE);
    // After the first 4 samples, the cursor wraps to 0 — sample 4 should
    // match sample 0 (same sample +16384 → 0.5 magnitude).
    expect(out[4 * 2]).toBeCloseTo(out[0], 5);
    expect((c.cnt >>> 31) & 1).toBe(1);
  });
});

describe('Sound — readByte/writeByte coverage of all register classes', () => {
  it('per-channel SAD/TMR/PNT/LEN read back what was written', () => {
    const sound = new Sound();
    // Write byte-by-byte to channel 1's SAD (offset 0x14..0x17).
    sound.writeByte(0x04000414, 0x11);
    sound.writeByte(0x04000415, 0x22);
    sound.writeByte(0x04000416, 0x33);
    sound.writeByte(0x04000417, 0x44);
    expect(sound.channels[1].sad >>> 0).toBe(0x44332211);
    expect(sound.readByte(0x04000414)).toBe(0x11);
    expect(sound.readByte(0x04000417)).toBe(0x44);
    // TMR at 0x418..0x419.
    sound.writeByte(0x04000418, 0xAB);
    sound.writeByte(0x04000419, 0xCD);
    expect(sound.channels[1].tmr & 0xFFFF).toBe(0xCDAB);
    expect(sound.readByte(0x04000418)).toBe(0xAB);
    // PNT at 0x41A..0x41B.
    sound.writeByte(0x0400041A, 0x12);
    sound.writeByte(0x0400041B, 0x34);
    expect(sound.channels[1].pnt & 0xFFFF).toBe(0x3412);
    expect(sound.readByte(0x0400041A)).toBe(0x12);
    // LEN at 0x41C..0x41F.
    sound.writeByte(0x0400041C, 0x55);
    sound.writeByte(0x0400041D, 0x66);
    sound.writeByte(0x0400041E, 0x77);
    sound.writeByte(0x0400041F, 0x88);
    expect(sound.channels[1].len >>> 0).toBe(0x88776655);
    expect(sound.readByte(0x0400041F)).toBe(0x88);
  });

  it('global SOUNDCNT / SOUNDBIAS / SNDCAPxCNT round-trip', () => {
    const sound = new Sound();
    sound.writeByte(0x04000500, 0x12);
    sound.writeByte(0x04000501, 0x34);
    expect(sound.soundcnt & 0xFFFF).toBe(0x3412);
    expect(sound.readByte(0x04000500)).toBe(0x12);
    expect(sound.readByte(0x04000501)).toBe(0x34);
    sound.writeByte(0x04000504, 0xAA);
    sound.writeByte(0x04000505, 0xBB);
    expect(sound.soundbias & 0xFFFF).toBe(0xBBAA);
    expect(sound.readByte(0x04000504)).toBe(0xAA);
    expect(sound.readByte(0x04000505)).toBe(0xBB);
    sound.writeByte(0x04000508, 0x44);
    expect(sound.sndcap0cnt).toBe(0x44);
    expect(sound.readByte(0x04000508)).toBe(0x44);
    sound.writeByte(0x04000509, 0x66);
    expect(sound.sndcap1cnt).toBe(0x66);
    expect(sound.readByte(0x04000509)).toBe(0x66);
  });

  it('readByte returns 0 for unmapped addresses in the sound range', () => {
    const sound = new Sound();
    expect(sound.readByte(0x04000510)).toBe(0);
    expect(sound.readByte(0x040005FF)).toBe(0);
  });

  it('key-on edge (writing bit 31 of cnt) starts the channel and resets posFrac', () => {
    const sound = new Sound();
    const c = sound.channels[0];
    // Pre-write the low bytes, then set bit 31 via byte 3 to trigger key-on.
    sound.writeByte(0x04000400, 0x7F);           // vol = 127
    sound.writeByte(0x04000401, 0);
    sound.writeByte(0x04000402, 0);
    // Pre-populate len + tmr so startChannel computes a non-zero cyclesLeft.
    sound.writeByte(0x04000408, 0); sound.writeByte(0x04000409, 0xF0);
    sound.writeByte(0x0400040C, 0x10); sound.writeByte(0x0400040D, 0);
    // Now write byte 3 with bit 7 set → bit 31 of cnt → key-on edge.
    sound.writeByte(0x04000403, 0x80);
    expect((c.cnt >>> 31) & 1).toBe(1);
    expect(c.cyclesLeft).toBeGreaterThan(0);
    expect(c.posFrac).toBe(0);
  });
});
