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
// SoundCount). No actual audio output yet; the registers are stored
// so games that poll channel-done bits work correctly.

const NUM_CHANNELS = 16;

interface Channel {
  cnt: number;        // 32-bit SOUND_CNT — bit 31 = key on/busy
  sad: number;        // 32-bit source address
  tmr: number;        // 16-bit timer period
  pnt: number;        // 16-bit loop point
  len: number;        // 32-bit length
  // Internal: cycles remaining until the sample would naturally end.
  // Counted down by step(); when it hits 0 we clear the key-on bit.
  cyclesLeft: number;
}

export class Sound {
  channels: Channel[] = Array.from({ length: NUM_CHANNELS }, () => ({
    cnt: 0, sad: 0, tmr: 0, pnt: 0, len: 0, cyclesLeft: 0,
  }));
  soundcnt = 0;
  soundbias = 0x200;       // default mid-rail
  sndcap0cnt = 0;
  sndcap1cnt = 0;
  sndcap0dad = 0;
  sndcap1dad = 0;
  sndcap0len = 0;
  sndcap1len = 0;

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
}
