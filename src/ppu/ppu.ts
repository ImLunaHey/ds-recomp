// Per-frame PPU scheduler. We don't render pixel-by-pixel yet — just
// count scanlines, raise VBlank IRQ at the right moment, and at the
// end of the visible area composite a 256×192 image for each engine.
// Real DS scanline timing: 355 dots/line × 263 lines/frame.
//
// The PPU exposes its state directly to the IoBus (DISPSTAT/VCOUNT).

import type { SharedMemory } from '../memory/shared';
import { Irq, IRQ_VBLANK, IRQ_HBLANK, IRQ_VCOUNT } from '../io/irq';
import { renderEngineA, renderEngineB } from './engine_a';
import type { Dma } from '../io/dma';
import type { Ipc } from '../io/ipc';
import { Gx } from './gx';

export const DOTS_PER_LINE  = 355;
export const LINES_PER_FRAME = 263;
export const VISIBLE_LINES  = 192;
export const SCREEN_W = 256;
export const SCREEN_H = 192;

export class Ppu {
  irq9: Irq;
  irq7: Irq;
  mem: SharedMemory;
  // DMAs are attached after construction (circular dep with Emulator).
  dma9: Dma | null = null;
  dma7: Dma | null = null;
  ipc: Ipc | null = null;
  gx: Gx;

  // DISPCNT for engines A and B (32-bit each).
  dispcntA = 0;
  dispcntB = 0;

  // BG layer control + scrolls for Engine A and B.
  bgCntA = new Uint16Array(4);
  bgHofsA = new Uint16Array(4);
  bgVofsA = new Uint16Array(4);
  bgCntB = new Uint16Array(4);
  bgHofsB = new Uint16Array(4);
  bgVofsB = new Uint16Array(4);

  // VRAMCNT_A..I — controls how each bank maps. The bus uses these via
  // VramRouter; the renderer also consults LCDC-direct mode when
  // DISPCNT display-mode 2 is selected.
  vramcnt = new Uint8Array(9);

  // MOSAIC register (engine A at 0x0400004C, engine B at 0x0400104C).
  // 4 nibbles: BG H size, BG V size, OBJ H size, OBJ V size (each "size"
  // is encoded as N-1 where N is the actual block width / height).
  mosaicA = 0;
  mosaicB = 0;

  // Window regions (GBATEK §"DS Video Window Feature").
  //   winH[0..1] = (right<<0) | (left<<8) — WIN0H / WIN1H
  //   winV[0..1] = (bottom<<0) | (top<<8) — WIN0V / WIN1V
  //   winIn  = WININ  (per-region BG/OBJ/special-effect enables)
  //   winOut = WINOUT (outside + OBJ-window enables)
  // One pair of state arrays per engine.
  winHA = new Uint16Array(2);
  winVA = new Uint16Array(2);
  winInA  = 0;
  winOutA = 0;
  winHB = new Uint16Array(2);
  winVB = new Uint16Array(2);
  winInB  = 0;
  winOutB = 0;

  // Color-special-effect registers (BLDCNT/BLDALPHA/BLDY). Per-engine.
  //   bldCnt   bit layout:
  //     0..5  = target-A pixels (BG0/1/2/3/OBJ/backdrop)
  //     6..7  = effect mode (0=none, 1=alpha, 2=fade-white, 3=fade-black)
  //     8..13 = target-B pixels
  //   bldAlpha bits 0..4 = EVA (0..16, clamped), bits 8..12 = EVB
  //   bldY     bits 0..4 = EVY (0..16, clamped)
  bldCntA   = 0;
  bldAlphaA = 0;
  bldYA     = 0;
  bldCntB   = 0;
  bldAlphaB = 0;
  bldYB     = 0;

  // MASTER_BRIGHT — final post-compositor brightness modulation.
  //   bits 0..4   = factor (0..16, clamped at 16)
  //   bits 14..15 = mode (0=disable, 1=fade-white, 2=fade-black, 3=reserved)
  masterBrightA = 0;
  masterBrightB = 0;

  // Display capture (Engine A only). DISPCAPCNT at 0x04000064 (32-bit).
  //   bit  31  = enable (cleared after capture)
  //   29..30  = source select (0=A, 1=B, 2/3=blend)
  //   26      = source-B select (0=VRAM, 1=main RAM FIFO)
  //   24..25  = source-A select (0=current frame, 1=3D)
  //   20..21  = capture size (0=128×128, 1=256×64, 2=256×128, 3=256×192)
  //   18..19  = write offset (which 32 KB block within the bank)
  //   16..17  = VRAM write bank (0=A, 1=B, 2=C, 3=D)
  //   8..12   = EVB
  //   0..4    = EVA
  dispCapCnt = 0;

  // ARM7-side VRAMSTAT: bit 0 = bank C in ARM7 mode, bit 1 = bank D.
  vramStat(): number {
    let v = 0;
    if ((this.vramcnt[2] & 0x87) === 0x82) v |= 0x01;
    if ((this.vramcnt[3] & 0x87) === 0x82) v |= 0x02;
    return v;
  }

  // Compositor framebuffers in 0x00BBGGRR (Uint8) form, 256×192 RGBA.
  fbA = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);
  fbB = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);

  // Scanline state.
  cyclesAccum = 0;  // cycles into current line
  vcount = 0;
  dispstat = 0;     // bits: 0=VBlank, 1=HBlank, 2=VCount match, 8..15=VCount target
  frameCount = 0;
  frameDone = false;

  constructor(mem: SharedMemory, irq9: Irq, irq7: Irq) {
    this.mem = mem;
    this.irq9 = irq9;
    this.irq7 = irq7;
    this.gx = new Gx(mem, irq9);
  }

  // Advance PPU by N ARM9 cycles. We share the same dot clock for
  // simplicity — every 1 ARM9 cycle = 1 dot. (Real hardware is 6
  // cycles/dot at 33 MHz ARM7, but for scheduling parity we model the
  // dot clock directly.)
  step(cycles: number): void {
    this.cyclesAccum += cycles;
    while (this.cyclesAccum >= DOTS_PER_LINE) {
      this.cyclesAccum -= DOTS_PER_LINE;
      this.endLine();
    }
    // HBlank flag mid-line, dot 256 onward.
    if (this.cyclesAccum >= 256) {
      if ((this.dispstat & 0x02) === 0) {
        this.dispstat |= 0x02;
        if (this.dispstat & 0x10) this.irq9.raise(IRQ_HBLANK);
      }
    } else {
      this.dispstat &= ~0x02;
    }
  }

  // New Super Mario Bros: the SDK's NitroFS file-system manager keeps an
  // FS-handle struct in main RAM at 0x02096114 with a vtable callback
  // pointer at +0x50 (= 0x02096164). On a real DS, ARM7 firmware's cart
  // boot path eventually triggers FS_Init which registers a default
  // async-read callback there. Without our cart layer being touched
  // (zero writes to 0x040001A0-AF during NSMB boot), that pointer
  // stays 0 — the dispatcher at 0x02069728 does `BLX [R5+0x50]`,
  // jumps to address 0 (BIOS), returns garbage that isn't 0/1/6, and
  // spins forever at PC 0x0206971c+ polling the state-code u32 at
  // 0x02096130. Patch a tiny "MOV R0,#0 ; BX LR" thunk into main RAM
  // at 0x027FF800 (shared OS area, BIOS-zerofilled) and install it
  // as the callback whenever the struct's "rom" tag is set. This
  // lets the dispatcher take its BEQ-on-zero path and exit the wait
  // loop, falling through into NSMB's actual graphics init.
  //
  // Detection: the struct is reliably tagged "rom\0" at +0x00 once
  // NSMB's crt0 has stamped it (around frame 64). We watch for that
  // exact pattern every VBlank and install the thunk lazily.
  private nsmbThunkInstalled = false;
  // Deadlock detector: many retail games' SDK runtimes enter a state
  // where ARM9 has WFI'd waiting for an IPC FIFO message from ARM7,
  // but ARM7's bring-up code never reaches the send site because of
  // some missing init (firmware data, cart key1, etc.). If we see no
  // real IPC FIFO traffic for 60+ frames AND both CPUs have FIFOs
  // enabled and at least one side has been doing IPC SYNC handshake
  // recently, synthesize a single 7→9 message to wake ARM9. This is
  // a heuristic but it's gated tightly enough not to disturb test
  // ROMs (RockWrestler's IPC FIFO test sends within ~10 frames of
  // enabling its FIFO).
  private applyIpcDeadlockHeartbeat(): void {
    if (!this.ipc) return;
    this.ipc.framesSinceLastSend++;
    if (!this.ipc.enable7 || !this.ipc.enable9) return;
    // Long quiet window required. RockWrestler's MEMORY → VRAM CNT
    // test legitimately pauses up to several seconds between FIFO
    // transactions while ARM9 navigates menus, so 60 frames was too
    // short; 300 (5 s) is safely past any normal game's pause.
    if (this.ipc.framesSinceLastSend < 300) return;
    if (this.ipc.q7to9.size > 0) return;
    // Empirical: even gated to NSMB (via FS-thunk-installed marker),
    // injecting 0x4D causes NSMB's ARM7 to enter BIOS region (likely
    // an undefined-instruction trap or unhandled mode switch) within
    // ~60 frames of the first inject. The agent's RE indicated this
    // value SHOULD be safe per protocol, so the breakage points to a
    // subtler missing piece in our IPC IRQ / dispatcher state. Until
    // we model that, leave the framework wired but skip the actual
    // write — at least the heartbeat plumbing is ready for the
    // moment we identify the safe inject value/timing.
    void 0;   // this.ipc.writeSend(false, 0x0000004D, true);
    this.ipc.framesSinceLastSend = -600;
  }

  private applyNsmbFsThunk(ram: Uint8Array): void {
    if (this.nsmbThunkInstalled) return;
    const tagOff = 0x96114;           // 0x02096114 & 0x3FFFFF
    if (ram[tagOff] !== 0x72 || ram[tagOff + 1] !== 0x6F ||
        ram[tagOff + 2] !== 0x6D || ram[tagOff + 3] !== 0x00) return;
    // Install thunk at 0x027FF800. We return 6 ("I/O ready/complete")
    // rather than 0 ("idle") — the agent's first guess of 0 took the
    // BEQ branch but the outer wait loop kept polling because no
    // forward progress happened. Return-6 takes a different branch
    // at 0x02069748 (BEQ 0x02069760 → calls a completion handler at
    // 0x02069760 instead of just clearing bit 0x200).
    const thunkOff = 0x7FF800 & 0x3FFFFF;
    // MOV R0, #6  → e3a00006
    ram[thunkOff]     = 0x06; ram[thunkOff + 1] = 0x00;
    ram[thunkOff + 2] = 0xA0; ram[thunkOff + 3] = 0xE3;
    // BX LR       → e12fff1e
    ram[thunkOff + 4] = 0x1E; ram[thunkOff + 5] = 0xFF;
    ram[thunkOff + 6] = 0x2F; ram[thunkOff + 7] = 0xE1;
    // Install pointer at 0x02096164 (R5 + 0x50).
    const cbOff = 0x96164;
    ram[cbOff]     = 0x00; ram[cbOff + 1] = 0xF8;
    ram[cbOff + 2] = 0x7F; ram[cbOff + 3] = 0x02;
    this.nsmbThunkInstalled = true;
  }

  // Findings from deeper RE of NSMB's main game task (entry 0x0206F1FC,
  // TCB 0x02096324):
  //
  // The task body loops waiting for bit 3 (= 0x8) of the field at
  // 0x020963F4 (= the game's "main controller struct" + 0x114). When
  // bit 3 is set, the task does:
  //   - BL 0x020F2240 (some work function)
  //   - LDR R1, [R5, +0x40]  ← function pointer at 0x02096320
  //   - BLX R1               ← calls registered frame-callback
  //   - B back to inner loop
  //
  // Both the bit-3 flag AND the function pointer at 0x02096320 are
  // expected to be set by NSMB's NitroMain post-OS_CreateThread setup.
  // In our boot, only OS_CreateThread runs; the post-setup is skipped
  // because the SDK's "switch to the new thread" handoff never fires
  // (we never find where NitroMain calls OS_RunThread, if it does).
  //
  // From-emulator setting the bit + a stub function pointer DOES make
  // ARM9 reach the BLX call and execute through the loop, but the
  // stub doesn't actually do per-frame rendering — that requires
  // NSMB's actual frame-update function whose address we'd need
  // source/symbols to identify. The work isn't bounded by emulator
  // emulator effort; it's a strict RE problem.
  //
  // Documenting the polled-flag location + function-pointer slot for
  // the next session's RE work. No code change here.

  // Pokemon Platinum: ARM9's THUMB validation routine at 0x02024370
  // bzero's 0x027FF000-0x027FF01C, then writes "ADAJ" ("ADAJ" = ASCII
  // 0x4A414441 = Pokemon's IPL ROM signature) to 0x027FF00C, then a
  // sub call, then expects 0x3130 ("01" = IPL version) at 0x027FF010.
  // The check at 0x020243ba is `LDRH R1, [0x027FF010] ; CMP R1, #0x3130`
  // and on FAIL it falls through to `BLX 0x020c42a8 (OS_Halt)` —
  // exactly the OS scheduler idle loop that's been blocking the boot.
  // Real DS firmware writes 0x3130 at 0x027FF010 as part of the
  // IPL-version stamp (GBATEK §"BIOS RAM Usage" calls 0x027FF000-AFF
  // "firmware-supplied data"). We don't run firmware so we stamp it
  // here, replayed every VBlank so the bzero that runs first can't
  // permanently wipe it.
  private applyPokemonIplStamp(ram: Uint8Array): void {
    const off = 0x7FF010 & 0x3FFFFF;
    // u16 = 0x3130 ("01"). Re-assert every VBlank so the bzero loop
    // can't keep it clear.
    ram[off]     = 0x30;
    ram[off + 1] = 0x31;
    // Also stamp the surrounding context the SDK init expects:
    // 0x027FF00C: "ADAJ" (signature)
    const sigOff = 0x7FF00C & 0x3FFFFF;
    ram[sigOff]     = 0x41;     // 'A'
    ram[sigOff + 1] = 0x44;     // 'D'
    ram[sigOff + 2] = 0x41;     // 'A'
    ram[sigOff + 3] = 0x4A;     // 'J'
  }

  private endLine(): void {
    this.vcount = (this.vcount + 1) % LINES_PER_FRAME;
    if (this.vcount === VISIBLE_LINES) {
      this.dispstat |= 0x01;          // VBlank
      if (this.dispstat & 0x08) this.irq9.raise(IRQ_VBLANK);
      this.irq7.raise(IRQ_VBLANK);    // ARM7 typically wants this unconditionally
      this.dma9?.triggerVBlank();
      this.dma7?.triggerVBlank();
      renderEngineA(this);
      renderEngineB(this);
      this.frameCount++;
      this.frameDone = true;
      // Per GBATEK §"BIOS RAM Usage", the ARM7 BIOS / SDK runtime
      // increments a frame counter at 0x027FFC3C every VBlank. Games
      // poll this for "time is passing". Our HLE ARM7 doesn't always
      // reach that user-handler code, so synthesize the increment.
      const ram = this.mem.mainRam;
      const off = 0x3FFC3C;            // 0x027FFC3C & 0x3FFFFF
      let v = ram[off] | (ram[off + 1] << 8) | (ram[off + 2] << 16) | (ram[off + 3] << 24);
      v = (v + 1) >>> 0;
      ram[off]     = v        & 0xFF;
      ram[off + 1] = (v >> 8) & 0xFF;
      ram[off + 2] = (v >> 16) & 0xFF;
      ram[off + 3] = (v >> 24) & 0xFF;
      this.applyNsmbFsThunk(ram);
      this.applyIpcDeadlockHeartbeat();
      // applyPokemonIplStamp(): tried and reverted — passing the
      // 0x3130 validation at 0x020243ba lets Pokemon's ARM9 fall
      // through into post-validation init code that we don't yet
      // model, and PC NOP-sleds into unmapped memory by frame 6.
      // The validation gate is real per the agent's analysis but the
      // unblock is only useful once more SDK-init values in
      // 0x027FF000-0x027FFAFF are also populated. Leaving the patch
      // documented but inactive until we know the full set.
      void this.applyPokemonIplStamp;
    } else if (this.vcount === 0) {
      this.dispstat &= ~0x01;         // VBlank ends
    }
    // VCount match
    const target = (this.dispstat >>> 8) & 0xFF;
    if (this.vcount === target) {
      this.dispstat |= 0x04;
      if (this.dispstat & 0x20) this.irq9.raise(IRQ_VCOUNT);
    } else {
      this.dispstat &= ~0x04;
    }
  }
}
