// Web Audio bridge — pulls samples from the emulated NDS sound chip
// (src/io/sound.ts) and pushes them to a browser AudioContext.
//
// We use ScriptProcessorNode because it's the simplest portable hook
// that runs synchronously on each audio callback — perfect for an
// emulator where we'd otherwise need to ferry sample data through
// MessagePort to an AudioWorklet. SP is deprecated but still
// universally supported and entirely fine for a demo/dev experience;
// upgrading to AudioWorklet later is a self-contained refactor.
//
// startAudio() is opt-in (browser autoplay policy) and called only
// from a user-gesture handler — the React "🔊 Audio" button.

import type { Sound } from '../io/sound';
import type { SharedMemory } from '../memory/shared';

interface AudioHandle {
  ctx: AudioContext;
  node: ScriptProcessorNode;
}

let active: AudioHandle | null = null;

// Open an AudioContext, wire it to sound.mix(), and start streaming.
// Idempotent — if audio is already running, this is a no-op. Returns
// the AudioContext's sample rate so the UI can show it.
export function startAudio(sound: Sound, mem: SharedMemory): number {
  if (active) return active.ctx.sampleRate;

  // Use a 2048-sample buffer — that's ~46 ms at 44.1 kHz. Smaller
  // buffers have less latency but more CPU overhead; this is a
  // reasonable middle ground that the ScriptProcessorNode spec
  // explicitly permits.
  const BUFFER_SIZE = 2048;
  const ctx = new AudioContext();
  // ScriptProcessorNode is on the deprecated path but still ubiquitous.
  // The TypeScript lib types include it.
  const node = ctx.createScriptProcessor(BUFFER_SIZE, 0, 2);

  // Wire the mixer's view of main RAM. The Sound instance keeps the
  // reference until stopAudio clears it.
  sound.mem = mem;

  node.onaudioprocess = (ev: AudioProcessingEvent) => {
    const outL = ev.outputBuffer.getChannelData(0);
    const outR = ev.outputBuffer.getChannelData(1);
    const frames = outL.length;
    const mix = sound.mix(frames, ctx.sampleRate);
    // Mix is interleaved L,R,L,R,...; de-interleave into the
    // ChannelData buffers the AudioContext wants.
    for (let i = 0; i < frames; i++) {
      outL[i] = mix[i * 2];
      outR[i] = mix[i * 2 + 1];
    }
  };
  node.connect(ctx.destination);

  active = { ctx, node };
  return ctx.sampleRate;
}

// Tear down any active audio output. Disconnects the processor node,
// closes the AudioContext, and unwires the mixer's memory ref so the
// Sound instance goes back to silent-ack mode.
export function stopAudio(sound: Sound): void {
  if (!active) return;
  try { active.node.disconnect(); } catch { /* already torn down */ }
  // close() returns a Promise but the caller doesn't care to await it;
  // browsers cleanly handle in-flight callbacks.
  void active.ctx.close();
  sound.mem = null;
  active = null;
}

// Useful for the UI to know whether the toggle button should render
// as on/off without keeping its own state. (Not currently consumed —
// React component tracks state explicitly.)
export function isAudioActive(): boolean {
  return active !== null;
}
