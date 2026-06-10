// Coverage for the NSMB NitroFS thunk in src/ppu/ppu.ts. The thunk
// fires once per VBlank from Ppu.endLine() and is responsible for:
//
//   - installing a 2-instruction "MOV R0,#6 ; BX LR" stub in main RAM
//     at 0x023FF800 (the canonical alias of 0x027FF800 — the SDK
//     firmware-data dead zone; canonical alias used because Cpu.step's
//     bad-branch guard rejects ARM9 PCs above 0x02400000), and
//   - pointing every FS-Archive handle's vtable slot (+0x50) at it,
//     so the SDK's dispatcher at 0x0206972c falls through its BEQ
//     instead of spinning on the polled state code.
//
// The thunk has a fast-path for NSMB's primary "rom\0" handle at the
// known fixed offset 0x02096114, and a structural sweep that picks
// up secondary archives (e.g. "snd\0", "ovl\0") wherever the game
// happens to place them in main RAM.
//
// We exercise both paths here:
//   1. fixed-offset primary handle is patched on the first VBlank
//      after the "rom\0" tag appears,
//   2. a secondary handle placed at an arbitrary high address is
//      also patched within a few VBlanks,
//   3. handles whose vtable slot already holds a real callback are
//      left alone (we don't clobber game-installed pointers),
//   4. random ASCII garbage that doesn't satisfy the structural
//      shape doesn't trigger a false-positive patch.

import { describe, it, expect } from 'vitest';
import { SharedMemory } from '../memory/shared';
import { Irq } from '../io/irq';
import { Ppu, DOTS_PER_LINE, LINES_PER_FRAME } from '../ppu/ppu';

const FRAME_DOTS = DOTS_PER_LINE * LINES_PER_FRAME;
const THUNK_ADDR = 0x023FF800;

function makePpu(): Ppu {
  const mem = new SharedMemory();
  const irq9 = new Irq();
  const irq7 = new Irq();
  return new Ppu(mem, irq9, irq7);
}

function writeU32LE(ram: Uint8Array, off: number, value: number): void {
  ram[off]     = value          & 0xFF;
  ram[off + 1] = (value >>>  8) & 0xFF;
  ram[off + 2] = (value >>> 16) & 0xFF;
  ram[off + 3] = (value >>> 24) & 0xFF;
}

function readU32LE(ram: Uint8Array, off: number): number {
  return (ram[off]            |
          (ram[off + 1] <<  8) |
          (ram[off + 2] << 16) |
          (ram[off + 3] << 24)) >>> 0;
}

// Stamp a synthetic FS-Archive handle into ram at the given main-RAM
// offset. Layout matches what looksLikeNsmbFsHandle in ppu.ts expects:
//   +0x00 : 4-byte FOUR-CC tag (3 letters + NUL)
//   +0x1C : u32 state code (small int — uninitialised, looks idle)
//   +0x50 : u32 vtable slot (0 = un-patched, to fix)
function stampHandle(ram: Uint8Array, off: number, tag: string,
                     vtable = 0, state = 0): void {
  for (let i = 0; i < 3; i++) ram[off + i] = tag.charCodeAt(i);
  ram[off + 3] = 0;
  writeU32LE(ram, off + 0x1C, state);
  writeU32LE(ram, off + 0x50, vtable);
}

// Drive the PPU through one full frame so endLine fires its VBlank
// hook (which is where applyNsmbFsThunk runs).
function tickFrame(ppu: Ppu): void {
  ppu.step(FRAME_DOTS);
}

describe('NSMB NitroFS thunk', () => {
  it('installs the primary "rom\\0" handle thunk on first VBlank', () => {
    const ppu = makePpu();
    const ram = ppu.mem.mainRam;
    // Stamp the primary handle at the canonical fixed offset.
    stampHandle(ram, 0x96114, 'rom');

    tickFrame(ppu);

    // Thunk body — 5 ARM instructions, see writeNsmbFsThunkBody in
    // ppu.ts for the why. The first three clear the "in-progress"
    // bit (0x200) of the FS handle's state word at [R0, #0x1C]; the
    // last two load #6 into R0 and BX LR.
    //   00: e590101c  LDR R1, [R0, #0x1C]
    //   04: e3c11c02  BIC R1, R1, #0x200
    //   08: e580101c  STR R1, [R0, #0x1C]
    //   0C: e3a00006  MOV R0, #6
    //   10: e12fff1e  BX LR
    const thunkOff = THUNK_ADDR & 0x3FFFFF;
    expect(readU32LE(ram, thunkOff +  0)).toBe(0xe590101c);
    expect(readU32LE(ram, thunkOff +  4)).toBe(0xe3c11c02);
    expect(readU32LE(ram, thunkOff +  8)).toBe(0xe580101c);
    expect(readU32LE(ram, thunkOff + 12)).toBe(0xe3a00006);
    expect(readU32LE(ram, thunkOff + 16)).toBe(0xe12fff1e);
    // Primary handle's +0x50 vtable slot now points at the thunk.
    expect(readU32LE(ram, 0x96114 + 0x50)).toBe(THUNK_ADDR);
  });

  it('does nothing while the primary "rom\\0" tag is absent', () => {
    const ppu = makePpu();
    const ram = ppu.mem.mainRam;
    // No tag stamped — the fast-path bails immediately and the sweep
    // is gated behind it, so nothing should be touched.

    tickFrame(ppu);

    const thunkOff = THUNK_ADDR & 0x3FFFFF;
    expect(readU32LE(ram, thunkOff)).toBe(0);
    expect(readU32LE(ram, 0x96114 + 0x50)).toBe(0);
  });

  it('also patches a secondary handle placed elsewhere in main RAM', () => {
    const ppu = makePpu();
    const ram = ppu.mem.mainRam;
    stampHandle(ram, 0x96114, 'rom');
    // Secondary "snd\0" handle in the upper 4 MB region (the agent
    // observed a real NSMB secondary handle's polled state at the
    // mirrored address 0x027E3774, which masks to offset 0x3E3774
    // inside the 4 MB main-RAM array).
    const secondaryAddr = 0x027E3758 & 0x3FFFFF;
    stampHandle(ram, secondaryAddr, 'snd');

    tickFrame(ppu);

    expect(readU32LE(ram, 0x96114 + 0x50)).toBe(THUNK_ADDR);
    expect(readU32LE(ram, secondaryAddr + 0x50)).toBe(THUNK_ADDR);
  });

  it('patches several differently-tagged handles in one sweep', () => {
    const ppu = makePpu();
    const ram = ppu.mem.mainRam;
    stampHandle(ram, 0x96114, 'rom');
    stampHandle(ram, 0x100000, 'snd');
    stampHandle(ram, 0x200000, 'ovl');
    stampHandle(ram, 0x300000, 'fnt');

    tickFrame(ppu);

    expect(readU32LE(ram, 0x96114 + 0x50)).toBe(THUNK_ADDR);
    expect(readU32LE(ram, 0x100000 + 0x50)).toBe(THUNK_ADDR);
    expect(readU32LE(ram, 0x200000 + 0x50)).toBe(THUNK_ADDR);
    expect(readU32LE(ram, 0x300000 + 0x50)).toBe(THUNK_ADDR);
  });

  it("doesn't clobber a handle whose vtable already holds a real callback", () => {
    const ppu = makePpu();
    const ram = ppu.mem.mainRam;
    stampHandle(ram, 0x96114, 'rom');
    // Secondary handle but with an already-installed real callback
    // (some address inside main RAM that isn't our thunk). The sweep
    // must leave this slot untouched.
    const realCallback = 0x02123456;
    stampHandle(ram, 0x180000, 'snd', realCallback);

    tickFrame(ppu);

    expect(readU32LE(ram, 0x96114 + 0x50)).toBe(THUNK_ADDR);
    expect(readU32LE(ram, 0x180000 + 0x50)).toBe(realCallback);
  });

  it("doesn't match ASCII tags outside the known FS-Archive allowlist", () => {
    const ppu = makePpu();
    const ram = ppu.mem.mainRam;
    stampHandle(ram, 0x96114, 'rom');
    // Scatter innocent ASCII strings with NULL-terminated FOUR-CC
    // shape but tags the SDK never uses. The allow-list match in
    // looksLikeNsmbFsTag should reject these — even though their
    // +0x50 vtable slot is zero (which would otherwise look fixable).
    const planted: Array<[number, string]> = [
      [0x140000, 'abc'],
      [0x150000, 'xyz'],
      [0x160000, 'mid'],
    ];
    for (const [off, tag] of planted) {
      for (let i = 0; i < 3; i++) ram[off + i] = tag.charCodeAt(i);
      ram[off + 3] = 0;
      writeU32LE(ram, off + 0x50, 0);
    }

    tickFrame(ppu);

    expect(readU32LE(ram, 0x96114 + 0x50)).toBe(THUNK_ADDR);
    for (const [off] of planted) {
      expect(readU32LE(ram, off + 0x50)).toBe(0);
    }
  });

  it('is idempotent across many frames', () => {
    const ppu = makePpu();
    const ram = ppu.mem.mainRam;
    stampHandle(ram, 0x96114, 'rom');
    stampHandle(ram, 0x200000, 'ovl');

    // Run a bunch of frames — the thunk should patch once per handle
    // and then stop touching anything.
    for (let i = 0; i < 5; i++) tickFrame(ppu);

    expect(readU32LE(ram, 0x96114 + 0x50)).toBe(THUNK_ADDR);
    expect(readU32LE(ram, 0x200000 + 0x50)).toBe(THUNK_ADDR);
    // Thunk body unchanged: same 5-instruction "clear bit 0x200, return 6"
    // pattern. We only spot-check the first and last words here — the
    // middle ones are covered by the primary-install test above.
    const thunkOff = THUNK_ADDR & 0x3FFFFF;
    expect(readU32LE(ram, thunkOff +  0)).toBe(0xe590101c);
    expect(readU32LE(ram, thunkOff + 16)).toBe(0xe12fff1e);
  });

  it('thunk address sits inside the ARM9 bad-branch-guard accepted range', () => {
    // Cpu.step rejects ARM9 PCs >= 0x02400000 and short-circuits a BX LR
    // when the prior instruction was a BLX to such an address. The thunk
    // address MUST stay below that bound — otherwise the BLX into the
    // thunk never actually executes MOV R0,#6, R0 retains its caller-
    // supplied value, the dispatcher's CMP R0,#6 fails, and the FS
    // request never completes. Keep this assertion so a "looks tidy,
    // let's move it back to the 0x027FF800 mirror" refactor trips.
    expect(THUNK_ADDR).toBeLessThan(0x02400000);
    // Sanity check: ensure the thunk address is also within main RAM
    // (not in DTCM/ITCM/BIOS), so the canonical/mirror equivalence
    // story holds.
    expect(THUNK_ADDR & 0x3FFFFF).toBe(0x3FF800);
  });

  it('the thunk actually executes when BLX-ed (round-trip via Cpu.step)', async () => {
    // Sets up the thunk via the normal path, then takes a CPU through
    // a synthetic BLX into the thunk address and confirms:
    //   - R0 = 6 on return (synchronous-completion return code),
    //   - PC returns to LR,
    //   - the FS-handle's state word at [R0_in, #0x1C] had bit 0x200
    //     cleared by the thunk's BIC sequence.
    // This is both the regression test for the "PC in mirror gets short-
    // circuited by the bad-branch guard" bug and coverage for the
    // state-clear extension (which the dispatcher itself doesn't perform
    // on the R0=6 branch — see ppu.ts writeNsmbFsThunkBody comment).
    const { Cpu } = await import('../cpu/cpu');
    const ppu = makePpu();
    const ram = ppu.mem.mainRam;
    stampHandle(ram, 0x96114, 'rom');
    // Mirror what the real dispatcher does just before the BLX: stamp
    // the "in-progress" bit (0x200) on top of whatever low bits the
    // handle's own init set. NSMB observed 0x213 at this point.
    writeU32LE(ram, 0x96114 + 0x1C, 0x00000213);
    tickFrame(ppu);

    // Bus9 from a fresh emulator-shaped wiring. We can't import Emulator
    // here without dragging in cart/bios; the PPU we just used already
    // has SharedMemory but no Bus9, so build one ourselves.
    const { Bus9 } = await import('../memory/bus9');
    const bus9 = new Bus9(ppu.mem);
    const cpu = new Cpu(bus9, true);
    cpu.reset(THUNK_ADDR, 0x0380FF00, 0x0380FFA0, 0x0380FFE0);
    // R0 holds the handle pointer on entry (as the dispatcher passes it).
    cpu.state.r[0] = 0x02096114;
    const returnAddr = 0x02000000;
    cpu.state.r[14] = returnAddr;

    // Five steps: LDR R1,[R0,#0x1C]; BIC R1,R1,#0x200; STR R1,[R0,#0x1C];
    // MOV R0,#6; BX LR.
    for (let i = 0; i < 5; i++) cpu.step();
    expect(cpu.state.r[0]).toBe(6);
    expect(cpu.state.r[15] & ~3).toBe(returnAddr);
    // Bit 0x200 must be cleared; the rest of the state word preserved.
    expect(readU32LE(ram, 0x96114 + 0x1C)).toBe(0x00000013);
  });

  it("doesn't disturb other bits of the handle's state word", async () => {
    // Sanity-check that the BIC mask is precisely #0x200 — neighbouring
    // bits (in particular 0x100 and 0x400) must survive untouched.
    const { Cpu } = await import('../cpu/cpu');
    const { Bus9 } = await import('../memory/bus9');
    const ppu = makePpu();
    const ram = ppu.mem.mainRam;
    stampHandle(ram, 0x96114, 'rom');
    tickFrame(ppu);

    const bus9 = new Bus9(ppu.mem);
    const cpu = new Cpu(bus9, true);
    cpu.reset(THUNK_ADDR, 0x0380FF00, 0x0380FFA0, 0x0380FFE0);
    cpu.state.r[0] = 0x96114 + 0x02000000;
    cpu.state.r[14] = 0x02000000;

    // Set every bit *except* 0x200; thunk must leave the rest alone.
    writeU32LE(ram, 0x96114 + 0x1C, 0xFFFFFDFF);
    for (let i = 0; i < 5; i++) cpu.step();
    expect(readU32LE(ram, 0x96114 + 0x1C)).toBe(0xFFFFFDFF);

    // Set every bit including 0x200; thunk must clear ONLY 0x200.
    writeU32LE(ram, 0x96114 + 0x1C, 0xFFFFFFFF);
    cpu.reset(THUNK_ADDR, 0x0380FF00, 0x0380FFA0, 0x0380FFE0);
    cpu.state.r[0] = 0x96114 + 0x02000000;
    cpu.state.r[14] = 0x02000000;
    for (let i = 0; i < 5; i++) cpu.step();
    expect(readU32LE(ram, 0x96114 + 0x1C)).toBe(0xFFFFFDFF);
  });
});
