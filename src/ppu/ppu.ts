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
  // at 0x023FF800 (shared OS area, BIOS-zerofilled) and install it
  // as the callback whenever the struct's "rom" tag is set. This
  // lets the dispatcher take its BEQ-on-zero path and exit the wait
  // loop, falling through into NSMB's actual graphics init.
  //
  // Address choice: the SDK BIOS-RAM block lives in the high mirror
  // 0x027FF800-0x027FFE00, but BLX'ing into that mirror trips the
  // Cpu.step bad-branch guard (which only accepts PC <0x02400000 for
  // ARM9 — main RAM mirrors above 0x02400000 are treated as garbage
  // PC and short-circuited via "simulate BX LR"). The canonical
  // alias 0x023FF800 maps to the same byte (mainRam offset 0x3FF800)
  // and IS accepted by the guard. Pointing the handle's vtable slot
  // at the canonical alias makes the BLX actually execute MOV R0,#6.
  //
  // Detection: the struct is reliably tagged "rom\0" at +0x00 once
  // NSMB's crt0 has stamped it (around frame 64). We watch for that
  // exact pattern every VBlank and install the thunk lazily.
  //
  // NSMB also installs SECONDARY FS handles for sound/overlay archives
  // — different tags ("snd\0", "ovl\0", …) at unpredictable offsets in
  // main RAM (the agent observed a hot polled state at 0x027E3774, well
  // away from the 0x02096114 primary handle). The same dispatcher is
  // called against those secondary handles too, so any handle whose
  // vtable slot is still NULL will spin in the same wait loop. After
  // installing the primary thunk we sweep main RAM for any FS-handle-
  // shaped struct (FOUR-CC ASCII tag at +0x00, NULL vtable at +0x50)
  // and point each one at the same MOV R0,#6 / BX LR stub.
  private nsmbThunkInstalled = false;
  // Offsets (relative to main RAM base) of every FS-handle struct we
  // have already patched, so re-sweeps skip them and we cap the total
  // count. Real-world NSMB exposes ≤4 handles; the cap is a sanity
  // limit, not a precise count.
  private nsmbFsHandlesPatched: number[] = [];
  // Frames since the primary thunk was installed — used to bound how
  // long we keep sweeping. Once NSMB has stamped all its archives
  // (well under 600 frames after the "rom" handle appears) further
  // sweeps just waste cycles.
  private nsmbFsSweepFrames = 0;
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

  // Maximum number of FS handles we will patch in a single boot. NSMB
  // installs at most a handful (rom/snd/ovl/…); anything beyond this
  // is almost certainly a false positive from the structural scan and
  // we'd rather under-patch than corrupt unrelated memory.
  private static readonly NSMB_FS_HANDLE_CAP = 8;
  // Stop sweeping for additional FS handles this many VBlanks after
  // the primary "rom\0" handle was patched. NSMB stamps the rest of
  // its archive registrations almost immediately, well inside this
  // window.
  private static readonly NSMB_FS_SWEEP_FRAMES = 600;

  // Address of the shared "MOV R0,#6 ; BX LR" thunk inside main RAM
  // (a BIOS-zerofilled stretch of the SDK firmware-data window). The
  // ROM never executes from here, so it's safe to overlay our stub.
  // Use the canonical 0x023FF800 alias instead of the 0x027FF800 high
  // mirror so the bad-branch guard in Cpu.step (which only treats
  // PC < 0x02400000 as ARM9-valid) actually executes the instructions
  // when BLX'd into. The byte storage is identical — both addresses
  // hit mainRam[0x3FF800] — but only the canonical alias survives
  // the guard.
  private static readonly NSMB_FS_THUNK_ADDR = 0x023FF800;

  // Write the shared ARM thunk into main RAM. Idempotent: re-running
  // the writes every VBlank simply restores the bytes if some code
  // (unlikely in this dead zone) trampled them.
  //
  // The thunk does two things before returning the synchronous-completion
  // code 6 in R0:
  //
  //   1. Clears bit 0x200 ("operation in progress") in the FS-handle's
  //      state word at [R0, #0x1C]. The dispatcher at 0x0206971c stamps
  //      that bit BEFORE the BLX into our vtable slot, but on the R0=6
  //      ("completed synchronously") branch (BEQ at 0x02069748 → B at
  //      0x0206975c → 0x02069794) the dispatcher never clears it itself
  //      — the only clear sites are on the R0=0 and R0=1 branches. So
  //      when the thunk returned 6 without touching state, the handle's
  //      +0x1C stayed "busy" forever; any later code (game frame thread,
  //      FS_GetResultCode, FS_IsBusy, etc.) polling "is FS idle?" never
  //      advanced. Observed: NSMB's primary "rom\0" handle state was
  //      frozen at 0x213 (= 0x200 | 0x13) for 200+ frames after the
  //      thunk ran. Clearing 0x200 here matches what the R0=0/R0=1
  //      branches of the dispatcher do, so it is safe semantics for the
  //      R0=6 path too.
  //
  //   2. Loads #6 into R0 and BX LR — the original synchronous-completion
  //      return convention. R0 is the handle pointer on entry; we read
  //      then overwrite it after the state-clear writeback completes.
  //
  // Layout (5 ARM instructions, 20 bytes):
  //   00:  e5901_01c  LDR R1, [R0, #0x1C]   ; load state word
  //   04:  e3c11c02  BIC R1, R1, #0x200    ; clear "in progress" bit
  //   08:  e5801_01c  STR R1, [R0, #0x1C]   ; store back
  //   0C:  e3a00006  MOV R0, #6            ; synchronous-completion code
  //   10:  e12fff1e  BX  LR                ; return
  private writeNsmbFsThunkBody(ram: Uint8Array): void {
    const thunkOff = Ppu.NSMB_FS_THUNK_ADDR & 0x3FFFFF;
    // LDR R1, [R0, #0x1C]  → e590101c
    ram[thunkOff +  0] = 0x1C; ram[thunkOff +  1] = 0x10;
    ram[thunkOff +  2] = 0x90; ram[thunkOff +  3] = 0xE5;
    // BIC R1, R1, #0x200   → e3c11c02
    ram[thunkOff +  4] = 0x02; ram[thunkOff +  5] = 0x1C;
    ram[thunkOff +  6] = 0xC1; ram[thunkOff +  7] = 0xE3;
    // STR R1, [R0, #0x1C]  → e580101c
    ram[thunkOff +  8] = 0x1C; ram[thunkOff +  9] = 0x10;
    ram[thunkOff + 10] = 0x80; ram[thunkOff + 11] = 0xE5;
    // MOV R0, #6           → e3a00006
    ram[thunkOff + 12] = 0x06; ram[thunkOff + 13] = 0x00;
    ram[thunkOff + 14] = 0xA0; ram[thunkOff + 15] = 0xE3;
    // BX LR                → e12fff1e
    ram[thunkOff + 16] = 0x1E; ram[thunkOff + 17] = 0xFF;
    ram[thunkOff + 18] = 0x2F; ram[thunkOff + 19] = 0xE1;
  }

  // Point an FS-handle struct's vtable slot (+0x50) at our shared
  // thunk. handleOff is the struct base relative to main RAM start.
  private installNsmbFsHandlePointer(ram: Uint8Array, handleOff: number): void {
    const cbOff = (handleOff + 0x50) & 0x3FFFFF;
    ram[cbOff]     = (Ppu.NSMB_FS_THUNK_ADDR      ) & 0xFF;
    ram[cbOff + 1] = (Ppu.NSMB_FS_THUNK_ADDR >>  8) & 0xFF;
    ram[cbOff + 2] = (Ppu.NSMB_FS_THUNK_ADDR >> 16) & 0xFF;
    ram[cbOff + 3] = (Ppu.NSMB_FS_THUNK_ADDR >> 24) & 0xFF;
  }

  // Known NitroSDK FS_Archive FOUR-CC tags, as little-endian u32 (the
  // ASCII bytes laid out at the struct's +0x00 in memory). Allow-list
  // matching only — restricting to known tags drops the structural
  // sweep's false-positive rate on 4 MB of RAM essentially to zero.
  // Add new tags here if a future game uses one we haven't seen.
  //   "rom\0" → 0x006D6F72 (ROM file archive — NSMB's primary handle)
  //   "ovl\0" → 0x006C766F (overlay archive)
  //   "snd\0" → 0x00646E73 (sound archive)
  //   "fnt\0" → 0x00746E66 (font archive)
  //   "arm\0" → 0x006D7261 (ARM-binary archive)
  //   "lz7\0" → 0x00377A6C (LZ77 compressed archive)
  //   "fat\0" → 0x00746166 (FAT archive)
  //   "dat\0" → 0x00746164 (generic data archive)
  private static readonly NSMB_FS_TAGS: ReadonlyArray<number> = [
    0x006D6F72, 0x006C766F, 0x00646E73, 0x00746E66,
    0x006D7261, 0x00377A6C, 0x00746166, 0x00746164,
  ];

  // Test whether the 4-byte window at ramOff carries one of the known
  // FS_Archive FOUR-CC tags. Operates on the little-endian u32 view so
  // the comparison is a single integer compare per candidate.
  private looksLikeNsmbFsTag(ram: Uint8Array, ramOff: number): boolean {
    const word = this.readU32LE(ram, ramOff);
    for (const tag of Ppu.NSMB_FS_TAGS) {
      if (word === tag) return true;
    }
    return false;
  }

  // Read the 4-byte little-endian word at ramOff as a u32.
  private readU32LE(ram: Uint8Array, ramOff: number): number {
    return (ram[ramOff] |
            (ram[ramOff + 1] << 8) |
            (ram[ramOff + 2] << 16) |
            (ram[ramOff + 3] << 24)) >>> 0;
  }

  // Decide whether the struct candidate at handleOff matches the FS-
  // handle shape closely enough to patch. We require the +0x50 slot
  // to be either NULL (the broken case we want to fix) or already
  // point into our installed thunk (re-patch / idempotency). We
  // deliberately do NOT match when +0x50 already points at an
  // arbitrary address that isn't our thunk — that means the game/SDK
  // installed a real callback and we must not clobber it. The
  // FOUR-CC tag check upstream is strong enough on its own to keep
  // the false-positive rate negligible on 4 MB of RAM.
  private looksLikeNsmbFsHandle(ram: Uint8Array, handleOff: number): boolean {
    const vtableOff = handleOff + 0x50;
    if (vtableOff + 4 > ram.length) return false;
    const vtable = this.readU32LE(ram, vtableOff);
    return vtable === 0 || vtable === Ppu.NSMB_FS_THUNK_ADDR;
  }

  private applyNsmbFsThunk(ram: Uint8Array): void {
    // Phase 1: primary "rom\0" handle at the known fixed offset. This
    // is the original, narrow detector — kept as a fast-path so we
    // don't pay sweep cost on every VBlank before the game has stamped
    // its FS-Archive table.
    if (!this.nsmbThunkInstalled) {
      const tagOff = 0x96114;           // 0x02096114 & 0x3FFFFF
      if (ram[tagOff] !== 0x72 || ram[tagOff + 1] !== 0x6F ||
          ram[tagOff + 2] !== 0x6D || ram[tagOff + 3] !== 0x00) return;
      // Install thunk at 0x023FF800 (canonical alias of 0x027FF800 —
      // same byte, but inside the bad-branch-guard's accepted range).
      // We return 6 ("I/O ready/complete") rather than 0 ("idle") —
      // the agent's first guess of 0 took the BEQ branch but the outer
      // wait loop kept polling because no forward progress happened.
      // Return-6 takes a different branch at 0x02069748 (BEQ
      // 0x02069760 → calls a completion handler at 0x02069760 instead
      // of just clearing bit 0x200).
      this.writeNsmbFsThunkBody(ram);
      // Install pointer at 0x02096164 (R5 + 0x50).
      const primaryHandleOff = 0x96114;
      this.installNsmbFsHandlePointer(ram, primaryHandleOff);
      this.nsmbFsHandlesPatched.push(primaryHandleOff);
      this.nsmbThunkInstalled = true;
    }

    // Phase 2: sweep main RAM for any additional FS-handle-shaped
    // structs (secondary archives like "snd\0" or "ovl\0"). NSMB's
    // FS dispatcher is reused for every handle, so an un-patched
    // secondary handle spins the same wait loop on its own state
    // word. We keep sweeping for a bounded window after the primary
    // handle appears, since the SDK may register additional archives
    // a few frames later than the ROM archive.
    if (this.nsmbFsSweepFrames >= Ppu.NSMB_FS_SWEEP_FRAMES) return;
    this.nsmbFsSweepFrames++;
    if (this.nsmbFsHandlesPatched.length >= Ppu.NSMB_FS_HANDLE_CAP) return;
    // Stride by 4 bytes — FS_Archive structs are word-aligned. Stop
    // 0x54 short of the end so the +0x50 vtable load doesn't run
    // off the array. The inner reject (tag pattern) is a 4-byte
    // memcmp-ish check that fails on the vast majority of slots,
    // so the sweep stays cheap even on 4 MB of RAM.
    const maxOff = ram.length - 0x54;
    for (let off = 0; off <= maxOff; off += 4) {
      if (!this.looksLikeNsmbFsTag(ram, off)) continue;
      if (!this.looksLikeNsmbFsHandle(ram, off)) continue;
      // Skip handles we've already patched (and skip re-patching
      // anything whose +0x50 already points at our thunk — the
      // looksLikeNsmbFsHandle check above allows that case so we
      // can recognise our own fingerprint, but there's no work to
      // do then).
      if (this.nsmbFsHandlesPatched.includes(off)) continue;
      const existing = this.readU32LE(ram, off + 0x50);
      if (existing === Ppu.NSMB_FS_THUNK_ADDR) {
        this.nsmbFsHandlesPatched.push(off);
        continue;
      }
      this.installNsmbFsHandlePointer(ram, off);
      this.nsmbFsHandlesPatched.push(off);
      if (this.nsmbFsHandlesPatched.length >= Ppu.NSMB_FS_HANDLE_CAP) break;
    }
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
