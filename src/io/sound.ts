// NDS sound chip — ARM7-only IO at 0x04000400-0x040005FF.
//
// Per GBATEK §"DS Sound" the chip exposes:
//   16 channels, each with 16 bytes of state at 0x04000400 + N*0x10:
//     +0x00..03  SOUND_CNT      vol/divider/hold/panning/duty/repeat/format/keyOn
//     +0x04..07  SOUND_SAD      source address (32-bit)
//     +0x08..09  SOUND_TMR      timer period (16-bit)
//     +0x0A..0B  SOUND_PNT      loop point (16-bit, halfwords from start)
//     +0x0C..0F  SOUND_LEN      sample length (32-bit, in halfwords)
//   SOUNDCNT     0x04000500     master vol + L/R out src + enable
//   SOUNDBIAS    0x04000504     bias level
//   SNDCAPxCNT   0x04000508/9   capture units (we stub)
//   SNDCAPxDAD   0x0400050C..   capture dest addrs
//   SNDCAPxLEN   0x04000514..   capture lengths
//
// We model state + reads + writes faithfully — channels can be "key on",
// will report key-off after their sample length elapses (driven from
// SoundCount). The mix() method additionally produces actual audio
// samples by walking each enabled channel's source memory at its
// timer-derived rate; the Web Audio bridge in src/audio/audio_bridge.ts
// pulls these into an AudioContext output buffer.

// NDS sound clock — every channel's timer counts up at 33.514 MHz and
// triggers a sample fetch on overflow, so sampleRate = clock /
// (0x10000 - tmr).
const NDS_SOUND_CLOCK = 33_513_982;
const NUM_CHANNELS = 16;

// SOUND_CNT format bits (bits 30:29).
const FMT_PCM8  = 0;
const FMT_PCM16 = 1;
const FMT_ADPCM = 2;
const FMT_PSG   = 3;

// IMA-ADPCM step / index tables. Values are the standard IMA-ADPCM
// constants (see Intel's "DVI ADPCM Wave Type" 1992 and the GBATEK
// "DS Sound Notes" §"ADPCM"). Identical across every DS/GBA emulator
// — DeSmuME (src/SPU.cpp), melonDS (src/SPU.cpp), and NocashGBA all
// use this table verbatim, so we know retail decoded output matches.
const ADPCM_STEP_TABLE: ReadonlyArray<number> = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371,
  408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166,
  1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
  3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
  8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
  20350, 22385, 24623, 27086, 29794, 32767,
];
const ADPCM_INDEX_TABLE: ReadonlyArray<number> = [
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
];

interface Channel {
  cnt: number;        // 32-bit SOUND_CNT — bit 31 = key on/busy
  sad: number;        // 32-bit source address
  tmr: number;        // 16-bit timer period
  pnt: number;        // 16-bit loop point
  len: number;        // 32-bit length
  // Internal: cycles remaining until the sample would naturally end.
  // Counted down by step(); when it hits 0 we clear the key-on bit.
  cyclesLeft: number;
  // Mixer cursor — fractional sample position within the channel's
  // source data, in *source* sample units (PCM8 byte index or PCM16
  // halfword index). Advanced by mix() according to the ratio of the
  // channel's NDS sample rate to the audio output rate.
  posFrac: number;
  // IMA-ADPCM decoder state. Reset on key-on from the 4-byte header
  // at SAD. We carry these forward sample-by-sample so the predictor
  // converges naturally — you cannot random-access an ADPCM stream.
  adpcmPredictor: number;      // signed 16-bit
  adpcmStepIndex: number;      // 0..88
  adpcmLastDecodedPos: number; // index of the last sample we resolved (-1 = need re-prime)
}

// Minimal memory accessor the mixer needs. We only support reading
// from main RAM (where DS sound samples virtually always live); VRAM
// would need bank routing and isn't worth the complexity for the
// audio bridge's smoke-test scope. Out-of-region reads return 0 so
// unmapped sources come back as silence rather than a crash.
export interface SoundMemory {
  mainRam: Uint8Array;
  arm7Iwram: Uint8Array;
}

export class Sound {
  channels: Channel[] = Array.from({ length: NUM_CHANNELS }, () => ({
    cnt: 0, sad: 0, tmr: 0, pnt: 0, len: 0, cyclesLeft: 0, posFrac: 0,
    adpcmPredictor: 0, adpcmStepIndex: 0, adpcmLastDecodedPos: -1,
  }));
  soundcnt = 0;
  soundbias = 0x200;       // default mid-rail
  sndcap0cnt = 0;
  sndcap1cnt = 0;
  sndcap0dad = 0;
  sndcap1dad = 0;
  sndcap0len = 0;
  sndcap1len = 0;
  // Memory the mixer reads sample data from. Optional — when null,
  // mix() emits silence. Wired up by the audio bridge when the user
  // enables sound output.
  mem: SoundMemory | null = null;

  // Map an address in 0x04000400-0x040005FF to byte access on our state.
  // Returns the byte value at that address (defaults to 0).
  readByte(addr: number): number {
    const a = addr & 0x0FFFFFFF;
    if (a >= 0x04000400 && a < 0x04000500) {
      const ch = (a - 0x04000400) >> 4;
      const off = (a - 0x04000400) & 0xF;
      const c = this.channels[ch];
      if (off < 4)        return (c.cnt >> ((off & 3) * 8)) & 0xFF;
      else if (off < 8)   return (c.sad >> (((off - 4) & 3) * 8)) & 0xFF;
      else if (off < 0xA) return (c.tmr >> (((off - 8) & 1) * 8)) & 0xFF;
      else if (off < 0xC) return (c.pnt >> (((off - 0xA) & 1) * 8)) & 0xFF;
      else                return (c.len >> (((off - 0xC) & 3) * 8)) & 0xFF;
    }
    switch (a) {
      case 0x04000500: return this.soundcnt & 0xFF;
      case 0x04000501: return (this.soundcnt >> 8) & 0xFF;
      case 0x04000504: return this.soundbias & 0xFF;
      case 0x04000505: return (this.soundbias >> 8) & 0xFF;
      case 0x04000508: return this.sndcap0cnt & 0xFF;
      case 0x04000509: return this.sndcap1cnt & 0xFF;
    }
    return 0;
  }

  writeByte(addr: number, v: number): void {
    const a = addr & 0x0FFFFFFF;
    v &= 0xFF;
    if (a >= 0x04000400 && a < 0x04000500) {
      const ch = (a - 0x04000400) >> 4;
      const off = (a - 0x04000400) & 0xF;
      const c = this.channels[ch];
      const before = c.cnt;
      if (off < 4) {
        const shift = (off & 3) * 8;
        c.cnt = ((c.cnt & ~(0xFF << shift)) | (v << shift)) >>> 0;
      } else if (off < 8) {
        const shift = ((off - 4) & 3) * 8;
        c.sad = ((c.sad & ~(0xFF << shift)) | (v << shift)) >>> 0;
      } else if (off < 0xA) {
        const shift = ((off - 8) & 1) * 8;
        c.tmr = ((c.tmr & ~(0xFF << shift)) | (v << shift)) & 0xFFFF;
      } else if (off < 0xC) {
        const shift = ((off - 0xA) & 1) * 8;
        c.pnt = ((c.pnt & ~(0xFF << shift)) | (v << shift)) & 0xFFFF;
      } else {
        const shift = ((off - 0xC) & 3) * 8;
        c.len = ((c.len & ~(0xFF << shift)) | (v << shift)) >>> 0;
      }
      // Key-on edge — bit 31 of cnt going 0 → 1.
      if (off === 3 && ((before >>> 31) & 1) === 0 && ((c.cnt >>> 31) & 1) === 1) {
        this.startChannel(c);
        // Restart the mixer cursor at the beginning of the sample so
        // we don't leak position state across key-on cycles.
        c.posFrac = 0;
        // Reset the ADPCM decoder so the next fetchSample() re-primes
        // from the 4-byte header at SAD. Harmless for PCM formats.
        c.adpcmPredictor = 0;
        c.adpcmStepIndex = 0;
        c.adpcmLastDecodedPos = -1;
      }
      return;
    }
    switch (a) {
      case 0x04000500: this.soundcnt = (this.soundcnt & 0xFF00) | v; return;
      case 0x04000501: this.soundcnt = (this.soundcnt & 0x00FF) | (v << 8); return;
      case 0x04000504: this.soundbias = (this.soundbias & 0xFF00) | v; return;
      case 0x04000505: this.soundbias = (this.soundbias & 0x00FF) | (v << 8); return;
      case 0x04000508: this.sndcap0cnt = v; return;
      case 0x04000509: this.sndcap1cnt = v; return;
    }
    // Capture dest/len writes etc — accept silently into a backing store.
  }

  // When a channel is key-on'd, compute how many ARM7 cycles it will take
  // before the natural end of the sample so we can auto-clear key-on
  // when the sample finishes.
  private startChannel(c: Channel): void {
    // tmr is a "negate count" — period in 33MHz cycles = (0x10000 - tmr).
    // SDK passes tmr such that bytes-per-cycle = tmr / 0x10000.
    // For sample length L (in halfwords) the total time ≈ L * (0x10000 - tmr).
    const period = (0x10000 - (c.tmr & 0xFFFF)) || 1;
    const lengthSamples = c.len >>> 0;
    // Clamp the simulated total to avoid runaway; cap at ~10 sec of cycles.
    const total = Math.min(lengthSamples * period, 33_513_982 * 10);
    c.cyclesLeft = total;
  }

  // Called from the ARM7 step loop. Decrements every key-on channel's
  // cycles-left; clears the key-on bit when it reaches 0.
  step(cycles: number): void {
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const c = this.channels[i];
      if ((c.cnt >>> 31) === 0) continue;        // not playing
      // Repeat-mode bit (cnt bits 27..28). 0 = manual / no auto-end.
      const repeat = (c.cnt >> 27) & 0x3;
      c.cyclesLeft -= cycles;
      if (c.cyclesLeft <= 0) {
        if (repeat === 1) {
          // Looping — re-prime cycle counter; key-on stays.
          this.startChannel(c);
        } else {
          // One-shot finished — clear key-on bit.
          c.cnt = (c.cnt & 0x7FFFFFFF) >>> 0;
          c.cyclesLeft = 0;
        }
      }
    }
  }

  // Per-channel volume (cnt bits 0..6, 0..127) and panning (bits 16..22,
  // 0=left, 64=center, 127=right). We normalize both to [0,1] floats
  // and apply equal-power-ish linear pan.
  private channelGains(c: Channel): { l: number; r: number } {
    const vol = (c.cnt & 0x7F) / 127;
    const pan = ((c.cnt >> 16) & 0x7F) / 127;
    // Linear pan — close enough for a smoke-test mixer, and matches
    // what most emulators do. (Real hardware uses a logarithmic
    // volume curve but we'd need lookup tables.)
    return { l: vol * (1 - pan), r: vol * pan };
  }

  // Fetch one source sample for `c` at integer source-position `pos`,
  // returning a signed value in roughly [-1, 1]. PSG / ADPCM return
  // 0 (silent placeholder) until proper decoders land.
  // Resolve a sound-sample address (main RAM mirrors at 0x027xxxxx,
  // ARM7 IWRAM at 0x037xxxxx) to a (bytes, offset) pair, or null if the
  // address doesn't land in a region we can stream from. Real DS sound
  // DMA reads main RAM most of the time, but some SDK paths place small
  // looped samples in ARM7 IWRAM — without this branch they were silent.
  private resolveSampleByte(addr: number): { bytes: Uint8Array; offset: number } | null {
    if (!this.mem) return null;
    const a = addr >>> 0;
    if (a >= 0x02000000 && a < 0x03000000) {
      // Main RAM (4 MB) + mirror at 0x027xxxxx — mask to bytes.
      const off = (a - 0x02000000) & (this.mem.mainRam.length - 1);
      return { bytes: this.mem.mainRam, offset: off };
    }
    if (a >= 0x037F8000 && a < 0x03810000) {
      // ARM7 IWRAM (64 KB)
      const off = a - 0x037F8000;
      if (off < this.mem.arm7Iwram.length) {
        return { bytes: this.mem.arm7Iwram, offset: off };
      }
    }
    return null;
  }

  private fetchSample(c: Channel, pos: number): number {
    const fmt = (c.cnt >> 29) & 0x3;
    if (fmt === FMT_PCM8) {
      // 1 byte per source sample. SOUND_LEN is in halfwords so the
      // PCM8 sample count is len*2 (each halfword = 2 bytes = 2 samples).
      const r = this.resolveSampleByte((c.sad + pos) >>> 0);
      if (!r) return 0;
      const u = r.bytes[r.offset];
      const s = u < 0x80 ? u : u - 0x100;
      return s / 128;
    }
    if (fmt === FMT_PCM16) {
      // 2 bytes per source sample. SOUND_LEN halfwords = sample count.
      const r = this.resolveSampleByte((c.sad + pos * 2) >>> 0);
      if (!r) return 0;
      const lo = r.bytes[r.offset];
      const hi = r.bytes[r.offset + 1];
      const u = (lo | (hi << 8)) & 0xFFFF;
      const s = u < 0x8000 ? u : u - 0x10000;
      return s / 32768;
    }
    if (fmt === FMT_ADPCM) {
      return this.decodeAdpcmSample(c, pos);
    }
    // PSG-pulse not yet implemented — emit silence.
    return 0;
  }

  // Decode the IMA-ADPCM sample at `sampleIdx` (0-based, after the
  // 4-byte header). The decoder is inherently sequential — sample N
  // depends on sample N-1's predictor/stepIndex — so we walk forward
  // from `adpcmLastDecodedPos+1` through `sampleIdx`, mutating the
  // channel's stored decoder state. When the requested index is
  // behind the cursor (loop wrap, key-on edge), we re-prime from the
  // header at SAD and walk from sample 0.
  //
  // Hot path: no allocations, only integer math + one table lookup
  // per intermediate sample. Called once per output sample for every
  // active ADPCM channel.
  private decodeAdpcmSample(c: Channel, sampleIdx: number): number {
    const r0 = this.resolveSampleByte(c.sad >>> 0);
    if (!r0) return 0;
    if (sampleIdx <= c.adpcmLastDecodedPos || c.adpcmLastDecodedPos < 0) {
      // Re-prime from the 4-byte header. Predictor is a signed 16-bit
      // value in the low halfword; step index is in the high byte, &
      // 0x7F per GBATEK (top bit is "loop info" — we ignore it here
      // and clamp to the 0..88 valid range).
      const bytes = r0.bytes;
      const off = r0.offset;
      const lo = bytes[off];
      const hi = bytes[off + 1];
      const u = (lo | (hi << 8)) & 0xFFFF;
      c.adpcmPredictor = u < 0x8000 ? u : u - 0x10000;
      let si = bytes[off + 2] & 0x7F;
      if (si > 88) si = 88;
      c.adpcmStepIndex = si;
      c.adpcmLastDecodedPos = -1;
    }
    // Advance the decoder from one past the last-decoded sample
    // through `sampleIdx`. Each step reads one nibble; the first
    // nibble of each byte is the LOW nibble. We index source bytes
    // as `sad + 4 + floor(n / 2)`.
    const bytes = r0.bytes;
    const baseOffset = r0.offset + 4;
    let predictor = c.adpcmPredictor;
    let stepIndex = c.adpcmStepIndex;
    for (let n = c.adpcmLastDecodedPos + 1; n <= sampleIdx; n++) {
      const byteOff = baseOffset + (n >> 1);
      // Guard against running off the end of the resolved buffer
      // (out-of-bounds reads return 0, which is a valid nibble byte).
      const b = byteOff < bytes.length ? bytes[byteOff] : 0;
      const nibble = (n & 1) === 0 ? (b & 0xF) : ((b >> 4) & 0xF);
      const step = ADPCM_STEP_TABLE[stepIndex];
      let diff = step >> 3;
      if (nibble & 1) diff += step >> 2;
      if (nibble & 2) diff += step >> 1;
      if (nibble & 4) diff += step;
      if (nibble & 8) diff = -diff;
      predictor += diff;
      if (predictor >  32767) predictor =  32767;
      else if (predictor < -32768) predictor = -32768;
      stepIndex += ADPCM_INDEX_TABLE[nibble];
      if (stepIndex < 0) stepIndex = 0;
      else if (stepIndex > 88) stepIndex = 88;
    }
    c.adpcmPredictor = predictor;
    c.adpcmStepIndex = stepIndex;
    c.adpcmLastDecodedPos = sampleIdx;
    return predictor / 32768;
  }

  // Total number of *source* samples in the channel (i.e. how far the
  // cursor can walk before needing to loop / stop). For PCM8 it's
  // len*2 bytes; for PCM16 it's len halfwords. Repeat / loop-point
  // wrap is handled per-format in stepCursor below.
  private channelSampleCount(c: Channel): number {
    const fmt = (c.cnt >> 29) & 0x3;
    if (fmt === FMT_PCM8)  return (c.len >>> 0) * 2;
    if (fmt === FMT_PCM16) return (c.len >>> 0);
    if (fmt === FMT_ADPCM) {
      // len is in halfwords. Each halfword = 4 nibbles = 4 samples,
      // minus the 4-byte (= 8 nibble) header that doesn't carry
      // payload samples. Floor at 0 so a degenerate len doesn't
      // produce a negative count.
      const n = ((c.len >>> 0) * 4) - 8;
      return n > 0 ? n : 0;
    }
    return 0;
  }

  // Loop-point in source-sample units (same scale as channelSampleCount).
  private channelLoopStart(c: Channel): number {
    const fmt = (c.cnt >> 29) & 0x3;
    // SOUND_PNT is in halfwords; convert to bytes for PCM8.
    if (fmt === FMT_PCM8)  return (c.pnt & 0xFFFF) * 2;
    if (fmt === FMT_PCM16) return (c.pnt & 0xFFFF);
    if (fmt === FMT_ADPCM) {
      // pnt is in halfwords from start; each halfword after the
      // 4-byte header is 4 nibble samples. We treat pnt as a
      // halfword offset into the payload, so the sample-space
      // loop-point is pnt*4. (The header lives in the first 2
      // halfwords, so games typically use pnt >= 2.)
      return (c.pnt & 0xFFFF) * 4;
    }
    return 0;
  }

  // Generate `numSamples` interleaved stereo Float32 samples at the
  // given output sample rate. Walks every key-on channel, decodes its
  // current source, applies vol+pan, and accumulates into the buffer.
  // Output samples are roughly in [-1, 1] after the final master-
  // volume divide; we let the AudioContext's destination clip.
  mix(numSamples: number, outputRate: number): Float32Array {
    const out = new Float32Array(numSamples * 2);
    // SOUNDCNT bit 15 = master enable. When 0, hardware mutes all
    // channels; we honor that here.
    if ((this.soundcnt & 0x8000) === 0) return out;
    // Master vol (SOUNDCNT bits 0..6, 0..127). Dividing by NUM_CHANNELS
    // (16) was over-conservative — most channels are silent so the
    // result was barely audible. Dividing by 4 (typical active-channel
    // count) gives reasonable headroom and we clamp per sample after
    // the channel accumulation so it can't clip.
    const masterVol = (this.soundcnt & 0x7F) / 127;
    const masterScale = masterVol / 4;

    for (let i = 0; i < NUM_CHANNELS; i++) {
      const c = this.channels[i];
      if ((c.cnt >>> 31) === 0) continue;       // not playing
      const fmt = (c.cnt >> 29) & 0x3;
      // PSG (square-wave) decoder isn't implemented yet — skip those
      // channels so we don't waste inner-loop cycles. ADPCM is wired
      // through fetchSample() below.
      if (fmt === FMT_PSG) continue;
      const period = (0x10000 - (c.tmr & 0xFFFF)) || 1;
      const chanRate = NDS_SOUND_CLOCK / period;
      // Source samples to advance per output sample.
      const step = chanRate / outputRate;
      const totalSamples = this.channelSampleCount(c);
      if (totalSamples === 0) continue;
      const repeat = (c.cnt >> 27) & 0x3;
      const loopStart = this.channelLoopStart(c);
      const { l: gL, r: gR } = this.channelGains(c);

      let pos = c.posFrac;
      for (let n = 0; n < numSamples; n++) {
        if (pos >= totalSamples) {
          if (repeat === 1) {
            // Loop back to the loop-point, preserving fractional phase
            // so the pitch doesn't glitch at the wrap boundary.
            const tail = pos - totalSamples;
            const span = totalSamples - loopStart;
            if (span > 0) pos = loopStart + (tail % span);
            else { pos = loopStart; }
          } else {
            // One-shot ended mid-buffer — stop emitting for this
            // channel and clear the key-on bit so the rest of the
            // step loop sees it as done.
            c.cnt = (c.cnt & 0x7FFFFFFF) >>> 0;
            break;
          }
        }
        const sIdx = Math.floor(pos);
        const s = this.fetchSample(c, sIdx);
        out[n * 2]     += s * gL * masterScale;
        out[n * 2 + 1] += s * gR * masterScale;
        pos += step;
      }
      c.posFrac = pos;
    }
    // Final hard clamp to [-1, 1] so the louder master scale doesn't
    // produce out-of-range values when many channels overlap.
    for (let n = 0; n < out.length; n++) {
      const v = out[n];
      if (v >  1) out[n] =  1;
      else if (v < -1) out[n] = -1;
    }
    return out;
  }
}
