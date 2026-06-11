// Tests for the IMA-ADPCM 4-bit decoder in src/io/sound.ts. ADPCM is
// used by most retail DS games for sound-effect + voice playback, and
// was previously emitting silence — these tests exercise the new
// decoder path through Sound.mix() / the private fetchSample helper.
//
// Strategy: we construct ADPCM payloads with known headers + nibble
// streams, then verify that the decoded predictor values match a
// reference implementation of the well-known IMA-ADPCM algorithm
// (step / index tables from Intel's 1992 DVI ADPCM Wave Type spec).

import { describe, it, expect, beforeEach } from 'vitest';
import { Sound } from '../io/sound';
import type { SoundMemory } from '../io/sound';

// Local copy of the same step/index tables the decoder uses. Having
// them inline lets the test verify the decoder against an independent
// reference implementation written from scratch — if either side
// diverges, the test fails.
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371,
  408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166,
  1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
  3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
  8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
  20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

function refDecodeNibble(state: { p: number; si: number }, nibble: number): void {
  const step = STEP_TABLE[state.si];
  let diff = step >> 3;
  if (nibble & 1) diff += step >> 2;
  if (nibble & 2) diff += step >> 1;
  if (nibble & 4) diff += step;
  if (nibble & 8) diff = -diff;
  state.p += diff;
  if (state.p > 32767) state.p = 32767;
  else if (state.p < -32768) state.p = -32768;
  state.si += INDEX_TABLE[nibble];
  if (state.si < 0) state.si = 0;
  else if (state.si > 88) state.si = 88;
}

// Build a SoundMemory with a payload at offset 0 of mainRam (matching
// the SAD = 0x02000000 we use in every test below). Allocates 64 KiB
// of RAM — plenty for any of these synthetic streams.
function makeMem(payload: Uint8Array): SoundMemory {
  const ram = new Uint8Array(64 * 1024);
  ram.set(payload, 0);
  return { mainRam: ram, arm7Iwram: new Uint8Array(64 * 1024) };
}

function enableMaster(s: Sound): void { s.soundcnt = 0x8000 | 0x7F; }

// Build a SOUND_CNT value with the standard fields populated. Bits
// 0..6 = vol, 16..22 = pan, 27..28 = repeat, 29..30 = format, 31 = on.
function buildCnt(vol: number, pan: number, fmt: number, repeat: number): number {
  return (
    (vol & 0x7F)
    | ((pan & 0x7F) << 16)
    | ((repeat & 0x3) << 27)
    | ((fmt & 0x3) << 29)
    | (1 << 31)
  ) >>> 0;
}

function startChannel(s: Sound, idx: number, opts: {
  vol: number; pan: number; fmt: number; repeat: number;
  sad: number; tmr: number; lenHalfwords: number;
}): void {
  const c = s.channels[idx];
  c.sad = opts.sad >>> 0;
  c.tmr = opts.tmr & 0xFFFF;
  c.len = opts.lenHalfwords >>> 0;
  c.pnt = 0;
  c.cnt = buildCnt(opts.vol, opts.pan, opts.fmt, opts.repeat);
  c.cyclesLeft = (0x10000 - c.tmr) * c.len;
  c.posFrac = 0;
  // Match the writeByte() key-on path's reset of decoder state.
  c.adpcmPredictor = 0;
  c.adpcmStepIndex = 0;
  c.adpcmLastDecodedPos = -1;
}

// Build an ADPCM payload: 4-byte header (predictor lo, predictor hi,
// stepIndex, 0) followed by `nibbles.length / 2` bytes where each
// byte holds two nibbles, LOW nibble first per GBATEK.
function buildAdpcm(predictor: number, stepIndex: number, nibbles: number[]): Uint8Array {
  const headerPredU = predictor < 0 ? (predictor + 0x10000) & 0xFFFF : predictor & 0xFFFF;
  const nBytes = Math.ceil(nibbles.length / 2);
  const out = new Uint8Array(4 + nBytes);
  out[0] = headerPredU & 0xFF;
  out[1] = (headerPredU >> 8) & 0xFF;
  out[2] = stepIndex & 0x7F;
  out[3] = 0;
  for (let i = 0; i < nibbles.length; i++) {
    const byteIdx = 4 + (i >> 1);
    if ((i & 1) === 0) out[byteIdx] |= nibbles[i] & 0xF;
    else out[byteIdx] |= (nibbles[i] & 0xF) << 4;
  }
  return out;
}

describe('Sound — IMA-ADPCM decoder', () => {
  let sound: Sound;
  beforeEach(() => { sound = new Sound(); enableMaster(sound); });

  it('key-on resets adpcmPredictor / adpcmStepIndex / adpcmLastDecodedPos', () => {
    // Pre-set decoder state, then write a key-on edge through the
    // public byte interface — the writeByte path is what resets the
    // decoder on real key-on transitions.
    const c = sound.channels[0];
    c.adpcmPredictor = 12345;
    c.adpcmStepIndex = 50;
    c.adpcmLastDecodedPos = 7;
    sound.writeByte(0x04000400, 0);
    sound.writeByte(0x04000401, 0);
    sound.writeByte(0x04000402, 0);
    sound.writeByte(0x04000408, 0); sound.writeByte(0x04000409, 0xF0);
    sound.writeByte(0x0400040C, 0x10); sound.writeByte(0x0400040D, 0);
    sound.writeByte(0x04000403, 0x80);          // key-on edge
    expect(c.adpcmPredictor).toBe(0);
    expect(c.adpcmStepIndex).toBe(0);
    expect(c.adpcmLastDecodedPos).toBe(-1);
  });

  it('decodes a constant-zero nibble stream into a slowly-changing predictor', () => {
    // All-zero nibbles: diff = step >> 3 each sample, predictor walks
    // upward from the header value. With header predictor = 0 and
    // step index = 0 (step = 7), the first sample is predictor = 0,
    // the next is 0 + (7>>3) = 0... step grows again only when the
    // nibble bit 4 is set, which it isn't here. Confirm via the
    // reference decoder that the stream is well-defined.
    const nibbles = Array.from<number>({ length: 32 }).fill(0);
    const payload = buildAdpcm(0, 0, nibbles);
    sound.mem = makeMem(payload);

    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 2,
      repeat: 1, sad: 0x02000000, tmr,
      lenHalfwords: 4 + Math.ceil(nibbles.length / 4),
    });

    // Reference decode of the first 16 samples.
    const ref = { p: 0, si: 0 };
    const expected: number[] = [];
    for (let i = 0; i < 16; i++) {
      refDecodeNibble(ref, nibbles[i]);
      expected.push(ref.p / 32768);
    }

    const out = sound.mix(16, OUTPUT_RATE);
    const gL = (63 / 127) / 4;
    for (let i = 0; i < 16; i++) {
      const got = out[i * 2] / gL;        // remove pan + master scale
      expect(got).toBeCloseTo(expected[i], 6);
    }
  });

  it('decodes an all-0xF-nibble stream toward a saturated negative predictor', () => {
    // Nibble 15 = bits 0..3 all set → diff = -(step + step/2 +
    // step/4 + step/8), the maximum-magnitude negative step. Each
    // nibble also bumps stepIndex by +8 so the step table races up
    // to the 32767 ceiling within ~12 samples. Predictor saturates
    // to -32768 quickly, and the stream stays pinned there.
    const nibbles = Array.from<number>({ length: 80 }).fill(15);
    const payload = buildAdpcm(0, 0, nibbles);
    sound.mem = makeMem(payload);

    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 2,
      repeat: 1, sad: 0x02000000, tmr,
      lenHalfwords: 4 + Math.ceil(nibbles.length / 4),
    });

    const out = sound.mix(80, OUTPUT_RATE);
    const gL = (63 / 127) / 4;
    // Late samples: predictor is pinned at -32768. The gain stack
    // means out[n*2] ≈ -1 * gL. We compare in pre-gain units.
    const late = out[60 * 2] / gL;
    expect(late).toBeLessThan(-0.95);
    // Mid stream: must already be strongly negative (no sign bug).
    expect(out[30 * 2]).toBeLessThan(0);
  });

  it('reproduces a synthetic ramp to within 5% after the step table converges', () => {
    // Encode a long ramp 0 → 28000 in steps of 250 (113 samples).
    // The step table is logarithmic and starts at 7 — we need ~30
    // samples for the table to ramp up before it can track a real
    // signal. We use a greedy encoder (pick whichever nibble brings
    // the predictor closest to the target each step) and then verify
    // the late samples are within 5% of the target — early samples
    // are deliberately excluded because the table hasn't converged.
    const targets: number[] = [];
    for (let i = 0; i <= 112; i++) targets.push(Math.round(i * 250));
    const enc = { p: 0, si: 0 };
    const nibbles: number[] = [];
    for (let i = 1; i < targets.length; i++) {
      const want = targets[i];
      let bestNibble = 0;
      let bestErr = Infinity;
      const saved = { p: enc.p, si: enc.si };
      for (let n = 0; n < 16; n++) {
        enc.p = saved.p; enc.si = saved.si;
        refDecodeNibble(enc, n);
        const err = Math.abs(enc.p - want);
        if (err < bestErr) { bestErr = err; bestNibble = n; }
      }
      // Commit the best nibble for real.
      enc.p = saved.p; enc.si = saved.si;
      refDecodeNibble(enc, bestNibble);
      nibbles.push(bestNibble);
    }

    const payload = buildAdpcm(0, 0, nibbles);
    sound.mem = makeMem(payload);

    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 2,
      repeat: 1, sad: 0x02000000, tmr,
      lenHalfwords: 4 + Math.ceil(nibbles.length / 4),
    });

    const out = sound.mix(nibbles.length, OUTPUT_RATE);
    const gL = (63 / 127) / 4;
    // Once the step table has converged (around sample 30+), every
    // decoded value should be within 5% of the target ramp.
    let converged = 0;
    for (let i = 30; i < nibbles.length; i++) {
      const got = out[i * 2] / gL;
      const want = targets[i + 1] / 32768;
      const err = Math.abs(got - want);
      const tol = Math.max(Math.abs(want) * 0.05, 0.01);
      if (err < tol) converged++;
    }
    // Demand the bulk of late samples meet the 5% bound.
    expect(converged).toBeGreaterThan((nibbles.length - 30) * 0.95);
  });

  it('Sound.mix integrates an ADPCM channel alongside a PCM8 channel', () => {
    // ADPCM in channel 0 with a stable +0.5 header predictor and an
    // all-zero nibble stream → the L/R output picks up roughly
    // 0.5 * gain on top of whatever PCM8 channel 1 contributes.
    // Verifies the mix loop now routes ADPCM through fetchSample
    // rather than skipping it (the previous behavior).
    const adpcm = buildAdpcm(16384, 0, Array.from<number>({ length: 16 }).fill(0));
    // PCM8 source: constant +0.5 — placed past the ADPCM payload in
    // main RAM so the two channels don't share bytes.
    const pcm8 = new Uint8Array([0x40, 0x40, 0x40, 0x40, 0x40, 0x40]);
    const combined = new Uint8Array(adpcm.length + pcm8.length);
    combined.set(adpcm, 0);
    combined.set(pcm8, adpcm.length);
    sound.mem = makeMem(combined);

    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    // Channel 0: ADPCM, hard-left (pan=0) so the contribution lands
    // entirely on the L output.
    startChannel(sound, 0, {
      vol: 127, pan: 0, fmt: 2,
      repeat: 1, sad: 0x02000000, tmr,
      lenHalfwords: 4 + Math.ceil(16 / 4),
    });
    // Channel 1: PCM8, hard-right (pan=127) so contribution lands on R.
    startChannel(sound, 1, {
      vol: 127, pan: 127, fmt: 0,
      repeat: 2, sad: (0x02000000 + adpcm.length) >>> 0, tmr,
      lenHalfwords: 3,
    });

    const out = sound.mix(2, OUTPUT_RATE);
    // L should be the ADPCM contribution (≈0.5 magnitude, divided by
    // /4 mixer scale). R should be the PCM8 contribution (+0.5 → ≈0.125).
    expect(out[0]).not.toBe(0);
    expect(out[1]).not.toBe(0);
    expect(out[0]).toBeGreaterThan(0.05);
    expect(out[1]).toBeCloseTo((0x40 / 128) * (1 / 4), 5);
  });

  it('channelSampleCount returns (len*4) - 8 for ADPCM channels', () => {
    // We can probe channelSampleCount via the one-shot cutoff path:
    // an ADPCM channel with len=3 halfwords should play
    // 3*4 - 8 = 4 source samples before silence. Each ADPCM sample
    // is one output sample at matched rate.
    const nibbles = Array.from<number>({ length: 16 }).fill(0);
    const payload = buildAdpcm(0, 0, nibbles);
    sound.mem = makeMem(payload);
    const OUTPUT_RATE = 32000;
    const tmr = 0x10000 - Math.round(33_513_982 / OUTPUT_RATE);
    startChannel(sound, 0, {
      vol: 127, pan: 64, fmt: 2,
      repeat: 2, sad: 0x02000000, tmr,
      lenHalfwords: 3,                  // 4 payload samples
    });
    const out = sound.mix(8, OUTPUT_RATE);
    // After 4 samples the one-shot must cut off → 0s in the tail.
    // (The active samples themselves may be 0 too with zero nibbles,
    // so we instead just verify the key-on cleared.)
    expect((sound.channels[0].cnt >>> 31) & 1).toBe(0);
    // Output beyond the cutoff is 0.
    for (let i = 5 * 2; i < out.length; i++) expect(out[i]).toBe(0);
  });
});
