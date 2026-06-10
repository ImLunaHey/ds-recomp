// Tests for the Sound.mix() audio-output path. Verifies that PCM8 and
// PCM16 sources are decoded correctly, that per-channel pan + master
// volume scale the L/R output as expected, and that a one-shot
// channel cuts off and emits silence after its sample length elapses.

import { describe, it, expect, beforeEach } from 'vitest';
import { Sound } from '../io/sound';
import type { SoundMemory } from '../io/sound';

// Synthesize a small `SoundMemory` with a sample payload starting at
// SOUND_SAD = 0x02000000 (i.e. offset 0 into main RAM). 64 KiB is
// more than enough for these tests.
function makeMem(samples: Uint8Array, off = 0): SoundMemory {
  const ram = new Uint8Array(64 * 1024);
  ram.set(samples, off);
  return { mainRam: ram };
}

// Wire master vol = max, master enable, L/R output from channel mix.
// SOUNDCNT layout: bits 0..6 = master vol, bit 15 = enable. Tests
// pick the simplest "everything on" config so we can isolate channel
// behavior.
function enableMaster(sound: Sound): void {
  sound.soundcnt = 0x8000 | 0x7F;
}

// Key on a channel with the given format/vol/pan/timer/sad/len, all
// passed as friendly numbers. cnt bit layout per GBATEK:
//   bits 0..6  = vol (0..127)
//   bits 16..22 = pan (0..127, 64=center)
//   bits 27..28 = repeat (0 manual, 1 loop, 2 one-shot)
//   bits 29..30 = format (0=PCM8, 1=PCM16, 2=ADPCM, 3=PSG)
//   bit 31      = key-on
function setChannel(sound: Sound, idx: number, opts: {
  vol: number; pan: number; fmt: number; repeat: number;
  sad: number; tmr: number; lenHalfwords: number;
}): void {
  const c = sound.channels[idx];
  c.sad = opts.sad >>> 0;
  c.tmr = opts.tmr & 0xFFFF;
  c.len = opts.lenHalfwords >>> 0;
  c.pnt = 0;
  c.cnt = (
    (opts.vol & 0x7F)
    | ((opts.pan & 0x7F) << 16)
    | ((opts.repeat & 0x3) << 27)
    | ((opts.fmt & 0x3) << 29)
    | (1 << 31)
  ) >>> 0;
  c.cyclesLeft = (0x10000 - c.tmr) * c.len;
  c.posFrac = 0;
}

describe('Sound.mix — PCM8 basic decode', () => {
  let sound: Sound;
  beforeEach(() => { sound = new Sound(); enableMaster(sound); });

  it('decodes PCM8 samples 1:1 when output rate matches channel rate', () => {
    // Source: PCM8 sequence [+64, -64, +127, -127, 0, 0]. In signed
    // 8-bit: 0x40, 0xC0, 0x7F, 0x81, 0x00, 0x00. Normalized: 0.5, -0.5,
    // ≈0.992, ≈-0.992, 0, 0.
    const payload = new Uint8Array([0x40, 0xC0, 0x7F, 0x81, 0x00, 0x00]);
    sound.mem = makeMem(payload);

    // Pick timer so channel rate == output rate. Then step == 1.
    // sampleRate = 33_513_982 / (0x10000 - tmr) -> for outputRate=32000
    // we want (0x10000 - tmr) = 33_513_982/32000 ≈ 1047. tmr = 64489.
    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);

    setChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 0,         // PCM8, centered
      repeat: 2, sad: 0x02000000, tmr,
      lenHalfwords: 3,                    // 3 halfwords = 6 bytes
    });

    const out = sound.mix(4, OUTPUT_RATE);
    // After master + per-channel + pan + /NUM_CHANNELS scaling.
    // Pan=64: gL = vol*(1-64/127) = 63/127, gR = vol*64/127 = 64/127.
    // Master vol = 127/127 = 1; per-output divide is /16.
    const gL = (63 / 127) / 16;
    const gR = (64 / 127) / 16;
    // Sample 0: +0.5 → L = 0.5*gL, R = 0.5*gR.
    expect(out[0]).toBeCloseTo(0.5 * gL, 5);
    expect(out[1]).toBeCloseTo(0.5 * gR, 5);
    // Sample 1: -0.5.
    expect(out[2]).toBeCloseTo(-0.5 * gL, 5);
    expect(out[3]).toBeCloseTo(-0.5 * gR, 5);
    // Sample 2: +127/128.
    expect(out[4]).toBeCloseTo((0x7F / 128) * gL, 5);
    // Sample 3: -127/128.
    expect(out[6]).toBeCloseTo((-0x7F / 128) * gL, 5);
  });
});

describe('Sound.mix — stereo separation via pan', () => {
  let sound: Sound;
  beforeEach(() => { sound = new Sound(); enableMaster(sound); });

  it('hard-left channel emits zero on R, hard-right channel emits zero on L', () => {
    // Two channels with identical constant-amplitude PCM8 buffers,
    // one hard-left (pan=0), one hard-right (pan=127). Mix and verify
    // each only contributes to its own side.
    const payload = new Uint8Array([0x40, 0x40, 0x40, 0x40, 0x40, 0x40]);
    sound.mem = makeMem(payload);

    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);

    setChannel(sound, 0, {
      vol: 127, pan: 0, fmt: 0,        // hard left
      repeat: 2, sad: 0x02000000, tmr,
      lenHalfwords: 3,
    });
    setChannel(sound, 1, {
      vol: 127, pan: 127, fmt: 0,      // hard right
      repeat: 2, sad: 0x02000000, tmr,
      lenHalfwords: 3,
    });

    const out = sound.mix(4, OUTPUT_RATE);
    // The hard-left channel must contribute 0 to R, the hard-right
    // must contribute 0 to L — verify each side carries only one
    // channel's signal. With pan=0/127 and vol=127, the per-side
    // gain is exactly (1 * 127/127) / 16 = 1/16 per active channel.
    const expected = 0.5 * (1 / 16);
    expect(out[0]).toBeCloseTo(expected, 4);     // L = ch0 only
    expect(out[1]).toBeCloseTo(expected, 4);     // R = ch1 only
    // Sanity — both sides should be EQUAL (each side has exactly one
    // hard-panned channel), so the separation isn't a fluke of
    // floating-point asymmetry.
    expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-6);
    expect(out[2]).toBeCloseTo(expected, 4);
    expect(out[3]).toBeCloseTo(expected, 4);
  });
});

describe('Sound.mix — PCM16 basic decode', () => {
  let sound: Sound;
  beforeEach(() => { sound = new Sound(); enableMaster(sound); });

  it('decodes PCM16 little-endian halfwords as signed', () => {
    // Two PCM16 samples: 0x4000 (=+16384 → 0.5) and 0xC000
    // (=-16384 → -0.5). Little-endian bytes: [0x00, 0x40, 0x00, 0xC0].
    const payload = new Uint8Array([0x00, 0x40, 0x00, 0xC0]);
    sound.mem = makeMem(payload);

    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);

    setChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 1,       // PCM16, centered
      repeat: 2, sad: 0x02000000, tmr,
      lenHalfwords: 2,
    });

    const out = sound.mix(2, OUTPUT_RATE);
    const gL = (63 / 127) / 16;
    const gR = (64 / 127) / 16;
    expect(out[0]).toBeCloseTo(0.5 * gL, 5);
    expect(out[1]).toBeCloseTo(0.5 * gR, 5);
    expect(out[2]).toBeCloseTo(-0.5 * gL, 5);
    expect(out[3]).toBeCloseTo(-0.5 * gR, 5);
  });
});

describe('Sound.mix — one-shot ends mid-buffer', () => {
  let sound: Sound;
  beforeEach(() => { sound = new Sound(); enableMaster(sound); });

  it('produces silence after a one-shot channel runs out of samples', () => {
    // Tiny 2-sample PCM8 source; one-shot mode. Once the cursor
    // walks past the end, the mixer must stop emitting for that
    // channel and the rest of the output buffer must be zero (no
    // other channels playing).
    const payload = new Uint8Array([0x40, 0x40]);
    sound.mem = makeMem(payload);

    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);

    setChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 0,
      repeat: 2, sad: 0x02000000, tmr,
      lenHalfwords: 1,                  // 1 halfword = 2 PCM8 bytes
    });

    const out = sound.mix(8, OUTPUT_RATE);
    const gL = (63 / 127) / 16;
    // First two samples are real signal, after that all zeros.
    expect(out[0]).toBeCloseTo(0.5 * gL, 5);
    expect(out[2]).toBeCloseTo(0.5 * gL, 5);
    for (let i = 4; i < 16; i++) expect(out[i]).toBe(0);
    // Key-on bit must have been cleared by the auto-cutoff.
    expect((sound.channels[0].cnt >>> 31) & 1).toBe(0);
  });
});

describe('Sound.mix — master mute', () => {
  let sound: Sound;
  beforeEach(() => { sound = new Sound(); });

  it('emits silence when SOUNDCNT bit 15 (master enable) is clear', () => {
    const payload = new Uint8Array([0x40, 0x40, 0x40, 0x40]);
    sound.mem = makeMem(payload);
    sound.soundcnt = 0x7F;                  // vol = max, but enable = 0

    setChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 0,
      repeat: 2, sad: 0x02000000, tmr: 0xF000,
      lenHalfwords: 2,
    });

    const out = sound.mix(4, 32000);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });
});

describe('Sound.mix — silent when no memory wired', () => {
  it('returns an all-zero buffer when mem is null', () => {
    const sound = new Sound();
    enableMaster(sound);
    setChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 0,
      repeat: 2, sad: 0x02000000, tmr: 0xF000,
      lenHalfwords: 2,
    });
    const out = sound.mix(4, 32000);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });
});
