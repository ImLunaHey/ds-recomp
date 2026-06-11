// Basic Gx (3D engine) unit tests. Drives writeFifo() / writeDirect()
// with synthetic command words and verifies the visible side-effects:
// matrix state on MTX_IDENTITY, currentColor on COLOR, and that VTX_16
// consumes the right number of parameter words.

import { describe, it, expect, beforeEach } from 'vitest';
import { Gx } from '../ppu/gx';
import { SharedMemory } from '../memory/shared';
import { Irq } from '../io/irq';

function makeGx(): Gx { return new Gx(new SharedMemory(), new Irq()); }

describe('Gx — empty FIFO', () => {
  it('no writes do nothing observable', () => {
    const gx = makeGx();
    // Nothing should be queued and no observable matrix state changes.
    expect(gx.cmdQueue.length).toBe(0);
    expect(gx.pendingOps.length).toBe(0);
    expect(gx.currentColor).toBe(0x7FFF);
    // Matrices stay identity.
    expect(gx.matProj[0]).toBe(1);
    expect(gx.matProj[5]).toBe(1);
    expect(gx.matProj[10]).toBe(1);
    expect(gx.matProj[15]).toBe(1);
  });
});

describe('Gx — MTX_IDENTITY (cmd 0x15)', () => {
  let gx: Gx;
  beforeEach(() => { gx = makeGx(); });

  it('loads identity into the current matrix stack (projection mode)', () => {
    // First, perturb the projection matrix so we can detect that
    // MTX_IDENTITY overwrites it.
    gx.matProj[0] = 9; gx.matProj[5] = 9; gx.matProj[10] = 9; gx.matProj[15] = 9;
    gx.matProj[1] = 3;
    // MTX_MODE = projection (0x10 with 1 param).
    gx.writeFifo(0x10);
    gx.writeFifo(0);
    // MTX_IDENTITY (0x15, no params).
    gx.writeFifo(0x15);
    // Now projection should be identity.
    expect(gx.matProj[0]).toBe(1);
    expect(gx.matProj[5]).toBe(1);
    expect(gx.matProj[10]).toBe(1);
    expect(gx.matProj[15]).toBe(1);
    expect(gx.matProj[1]).toBe(0);
  });

  it('loads identity into the position matrix when matMode = position', () => {
    gx.matPos[0] = 7;
    gx.writeFifo(0x10);
    gx.writeFifo(1);
    gx.writeFifo(0x15);
    expect(gx.matPos[0]).toBe(1);
    expect(gx.matPos[5]).toBe(1);
  });
});

describe('Gx — COLOR (cmd 0x20)', () => {
  it('latches a 15-bit color into currentColor', () => {
    const gx = makeGx();
    // 0x20 takes 1 param.
    gx.writeFifo(0x20);
    gx.writeFifo(0x1234);          // arbitrary 15-bit color
    expect(gx.currentColor).toBe(0x1234 & 0x7FFF);
  });

  it('high bits of the COLOR parameter are masked away', () => {
    const gx = makeGx();
    gx.writeFifo(0x20);
    gx.writeFifo(0xFFFFFFFF);
    expect(gx.currentColor).toBe(0x7FFF);
  });
});

describe('Gx — VTX_16 (cmd 0x23)', () => {
  it('consumes exactly 2 parameter words and produces a vertex inside BEGIN_VTXS', () => {
    const gx = makeGx();
    // Setup: identity projection + position.
    gx.writeFifo(0x10); gx.writeFifo(0);   // matrix mode = proj
    gx.writeFifo(0x15);                     // identity
    gx.writeFifo(0x10); gx.writeFifo(1);   // matrix mode = pos
    gx.writeFifo(0x15);                     // identity
    // BEGIN_VTXS triangle list.
    gx.writeFifo(0x40); gx.writeFifo(0);
    expect(gx.vertexBuf.length).toBe(0);
    // VTX_16 — 2 parameter words.
    gx.writeFifo(0x23);
    gx.writeFifo(0);            // X=0, Y=0
    expect(gx.vertexBuf.length).toBe(0);     // still waiting for 2nd param
    gx.writeFifo(0);            // Z=0
    // Now a vertex should be in the buffer.
    expect(gx.vertexBuf.length).toBe(1);
    expect(gx.pendingOps.length).toBe(0);    // command fully consumed
    expect(gx.pendingParams.length).toBe(0);
  });
});

describe('Gx — MTX_PUSH / MTX_POP (cmd 0x11 / 0x12)', () => {
  it('PUSH saves projection matrix, POP restores it', () => {
    const gx = makeGx();
    // Mode = projection, then perturb the matrix.
    gx.writeFifo(0x10); gx.writeFifo(0);
    gx.matProj[0] = 5;
    // PUSH (no params).
    gx.writeFifo(0x11);
    expect(gx.projStack.length).toBe(1);
    // Perturb further.
    gx.matProj[0] = 99;
    // POP with count = 1 (low 5 bits).
    gx.writeFifo(0x12); gx.writeFifo(1);
    // Stack drained, matrix restored to the saved value (5).
    expect(gx.projStack.length).toBe(0);
    expect(gx.matProj[0]).toBe(5);
  });

  it('PUSH/POP for position-mode pushes onto posStack', () => {
    const gx = makeGx();
    gx.writeFifo(0x10); gx.writeFifo(1);   // mode = position
    gx.matPos[5] = 7;
    gx.writeFifo(0x11);                     // PUSH
    expect(gx.posStack.length).toBe(1);
    gx.matPos[5] = 88;
    gx.writeFifo(0x12); gx.writeFifo(1);   // POP 1
    expect(gx.posStack.length).toBe(0);
    expect(gx.matPos[5]).toBe(7);
  });
});

describe('Gx — MTX_LOAD_4x4 (cmd 0x16)', () => {
  it('consumes 16 parameter words and loads the matrix into the current stack', () => {
    const gx = makeGx();
    gx.writeFifo(0x10); gx.writeFifo(0);     // proj mode
    // Build a 16-entry matrix in Q4.12 fixed-point (4096 = 1.0).
    // Identity-but-perturbed: m[0]=2, m[5]=3, m[10]=4, m[15]=1; rest 0.
    gx.writeFifo(0x16);
    for (let i = 0; i < 16; i++) {
      let v = 0;
      if (i === 0) v = 2 * 4096;
      else if (i === 5) v = 3 * 4096;
      else if (i === 10) v = 4 * 4096;
      else if (i === 15) v = 1 * 4096;
      gx.writeFifo(v >>> 0);
    }
    // Now the projection matrix should have m[0]=2, m[5]=3, m[10]=4, m[15]=1.
    expect(gx.matProj[0]).toBeCloseTo(2, 5);
    expect(gx.matProj[5]).toBeCloseTo(3, 5);
    expect(gx.matProj[10]).toBeCloseTo(4, 5);
    expect(gx.matProj[15]).toBeCloseTo(1, 5);
  });
});

describe('Gx — MTX_TRANS / MTX_SCALE (cmd 0x1C / 0x1B)', () => {
  it('MTX_TRANS multiplies the current matrix by a translation', () => {
    const gx = makeGx();
    gx.writeFifo(0x10); gx.writeFifo(1);     // mode = position
    gx.writeFifo(0x15);                       // identity
    // MTX_TRANS takes 3 Q4.12 params. Translate by (2, 3, 4).
    gx.writeFifo(0x1C);
    gx.writeFifo(2 * 4096); gx.writeFifo(3 * 4096); gx.writeFifo(4 * 4096);
    // Result: column-major m[12]=2, m[13]=3, m[14]=4.
    expect(gx.matPos[12]).toBeCloseTo(2, 5);
    expect(gx.matPos[13]).toBeCloseTo(3, 5);
    expect(gx.matPos[14]).toBeCloseTo(4, 5);
  });

  it('MTX_SCALE multiplies the current matrix by a scale', () => {
    const gx = makeGx();
    gx.writeFifo(0x10); gx.writeFifo(1);
    gx.writeFifo(0x15);
    gx.writeFifo(0x1B);                       // scale
    gx.writeFifo(2 * 4096); gx.writeFifo(3 * 4096); gx.writeFifo(4 * 4096);
    expect(gx.matPos[0]).toBeCloseTo(2, 5);
    expect(gx.matPos[5]).toBeCloseTo(3, 5);
    expect(gx.matPos[10]).toBeCloseTo(4, 5);
  });
});

describe('Gx — VTX_10 / VTX_XY / VTX_DIFF', () => {
  function setupForVtx(gx: Gx): void {
    gx.writeFifo(0x10); gx.writeFifo(0); gx.writeFifo(0x15);   // proj=id
    gx.writeFifo(0x10); gx.writeFifo(1); gx.writeFifo(0x15);   // pos=id
    gx.writeFifo(0x40); gx.writeFifo(0);                        // BEGIN tri list
  }

  it('VTX_10 (cmd 0x24) consumes 1 word and produces a vertex', () => {
    const gx = makeGx();
    setupForVtx(gx);
    gx.writeFifo(0x24);
    gx.writeFifo(0);          // x=y=z=0
    expect(gx.vertexBuf.length).toBe(1);
    expect(gx.pendingOps.length).toBe(0);
  });

  it('VTX_XY (cmd 0x25) consumes 1 word and uses lastVtxZ', () => {
    const gx = makeGx();
    setupForVtx(gx);
    // Set lastVtxZ via a VTX_16 first.
    gx.writeFifo(0x23); gx.writeFifo(0); gx.writeFifo(7 * 4096);
    expect(gx.vertexBuf.length).toBe(1);
    expect(gx.lastVtxZ).toBeCloseTo(7, 5);
    // Now VTX_XY: only 1 param word.
    gx.writeFifo(0x25);
    gx.writeFifo(0);
    expect(gx.vertexBuf.length).toBe(2);
    expect(gx.lastVtxZ).toBeCloseTo(7, 5);     // Z unchanged
  });

  it('VTX_DIFF (cmd 0x28) consumes 1 word and accumulates deltas', () => {
    const gx = makeGx();
    setupForVtx(gx);
    gx.writeFifo(0x23); gx.writeFifo(0); gx.writeFifo(0);
    const beforeX = gx.lastVtxX;
    gx.writeFifo(0x28);
    // dx=dy=dz=0 in 6.4 fixed-point → no change.
    gx.writeFifo(0);
    expect(gx.lastVtxX).toBeCloseTo(beforeX, 5);
    expect(gx.vertexBuf.length).toBe(2);
  });
});

describe('Gx — direct command port writeDirect', () => {
  it('writeDirect at port for op 0x15 (MTX_IDENTITY) triggers the command', () => {
    const gx = makeGx();
    // 0x15 takes 0 params — but writeDirect always supplies one value.
    // The starts-a-new-pendingOp branch in writeDirect pushes [op] + [value],
    // and tryDrain shifts op once need=0 (since 0 <= 1 params present).
    // (op - 0x10) * 4 = (0x15 - 0x10) * 4 = 0x14, so register = 0x04000440 + 0x14.
    gx.writeDirect(0x04000440 + 0x14, 0);
    // After firing, the matrix should be identity (it already was — but the
    // command went through pendingOps without leaving residue).
    expect(gx.pendingOps.length).toBe(0);
  });

  it('writeDirect with the same op continues the pending parameter list', () => {
    const gx = makeGx();
    // MTX_LOAD_4x4 (op 0x16) takes 16 params. Stream them via writeDirect.
    const reg = 0x04000440 + (0x16 - 0x10) * 4;
    for (let i = 0; i < 16; i++) {
      const v = i === 0 || i === 5 || i === 10 || i === 15 ? 4096 : 0;
      gx.writeDirect(reg, v);
    }
    // Should have fired exactly one command.
    expect(gx.pendingOps.length).toBe(0);
    expect(gx.matPos[0]).toBeCloseTo(1, 5);
  });
});

describe('Gx — SWAP_BUFFERS (cmd 0x50)', () => {
  it('promotes fbBack to fbFront and clears fbBack', () => {
    const gx = makeGx();
    // Seed fbBack with a recognizable pattern.
    gx.fbBack[100] = 0xABCD;
    gx.fbBack[200] = 0x1234;
    gx.writeFifo(0x50); gx.writeFifo(0);
    expect(gx.fbFront[100]).toBe(0xABCD);
    expect(gx.fbFront[200]).toBe(0x1234);
    // fbBack must be cleared.
    expect(gx.fbBack[100]).toBe(0);
    expect(gx.fbBack[200]).toBe(0);
  });
});

describe('Gx — unhandled command silently consumes its params', () => {
  it('cmd 0x30 (DIF_AMB, 1 param) is consumed without crash', () => {
    const gx = makeGx();
    gx.writeFifo(0x30);
    gx.writeFifo(0xDEADBEEF);
    expect(gx.pendingOps.length).toBe(0);
    expect(gx.pendingParams.length).toBe(0);
  });
});
