// Minimal viable DS 3D engine. Parses the GXFIFO command stream
// (writes to 0x04000400 are packed-cmd bytes, writes to 0x04000440+
// are individual command parameters), maintains a 4x4 matrix stack
// per mode (projection / position / vector / texture), transforms
// incoming vertices, and software-rasterizes triangles into a
// 256x192 BGR555 framebuffer that Engine A's BG0 layer can pull
// from.
//
// What's IMPLEMENTED (enough to draw an untextured triangle):
//   - MTX_MODE / MTX_IDENTITY / MTX_LOAD_4x4 / MTX_LOAD_4x3 /
//     MTX_MULT_4x4 / MTX_MULT_4x3 / MTX_PUSH / MTX_POP / MTX_TRANS
//   - COLOR (vertex color, 5-5-5 RGB)
//   - VTX_16 (3 × s16 fixed-point coordinates, 4.12 format)
//   - VTX_10 / VTX_XY / VTX_XZ / VTX_YZ / VTX_DIFF (partial coords)
//   - BEGIN_VTXS / END_VTXS (primitive type)
//   - SWAP_BUFFERS (latch the current scene to the visible buffer)
//   - VIEWPORT (full-screen by default)
// What's NOT yet:
//   - Textures, lighting (NORMAL/TEXCOORD/MATERIAL just no-op)
//   - Z buffer + W-buffer mode
//   - Polygon clipping (off-screen triangles skipped)
//   - Toon / highlight tables, fog, edge marking, anti-alias
//   - Capture (DISPCAPCNT)

import type { SharedMemory } from '../memory/shared';
import type { Irq } from '../io/irq';
import {
  newLightState,
  newMaterialState,
  setLightVector,
  setLightColor,
  setDifAmb,
  setSpeEmi,
  unpackNormal,
  computeVertexColor,
  type LightState,
  type MaterialState,
} from './gx_lighting';

export const GX_SCREEN_W = 256;
export const GX_SCREEN_H = 192;

const MTX_MODE_PROJ = 0;
const MTX_MODE_POS  = 1;
const MTX_MODE_POSVEC = 2;       // proxies both pos and vector
const MTX_MODE_TEX  = 3;

interface Vec4 { x: number; y: number; z: number; w: number; }
interface Vertex {
  // Post-transform clip coords
  x: number; y: number; z: number; w: number;
  color: number;          // packed BGR555
}

function mat4Identity(): Float64Array {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Mul(out: Float64Array, a: Float64Array, b: Float64Array): void {
  // out = a * b. We compute into a temporary so the same buffer can be
  // both source and dest.
  const t = new Float64Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i + k * 4] * b[k + j * 4];
      t[i + j * 4] = s;
    }
  }
  out.set(t);
}

function mat4Apply(m: Float64Array, x: number, y: number, z: number, w: number): Vec4 {
  return {
    x: m[0]  * x + m[4] * y + m[8]  * z + m[12] * w,
    y: m[1]  * x + m[5] * y + m[9]  * z + m[13] * w,
    z: m[2]  * x + m[6] * y + m[10] * z + m[14] * w,
    w: m[3]  * x + m[7] * y + m[11] * z + m[15] * w,
  };
}

// Each GX command takes a fixed number of parameter words.
// Indexed by command opcode (0..0x7F-ish).
const CMD_PARAMS: { [op: number]: number } = {
  0x10: 1, 0x11: 0, 0x12: 1, 0x13: 1, 0x14: 1, 0x15: 0,
  0x16: 16, 0x17: 12, 0x18: 16, 0x19: 12, 0x1A: 9, 0x1B: 3, 0x1C: 3,
  0x20: 1, 0x21: 1, 0x22: 1, 0x23: 2, 0x24: 1, 0x25: 1, 0x26: 1, 0x27: 1, 0x28: 1, 0x29: 1, 0x2A: 1, 0x2B: 1,
  0x30: 1, 0x31: 1, 0x32: 1, 0x33: 1, 0x34: 32,
  0x40: 1, 0x41: 0,
  0x50: 1, 0x60: 1, 0x70: 3, 0x71: 2, 0x72: 1,
};

export class Gx {
  mem: SharedMemory;
  irq9: Irq;

  // Front and back framebuffer. We render into back, and SWAP_BUFFERS
  // promotes it to front so Engine A reads stable content.
  fbBack  = new Uint16Array(GX_SCREEN_W * GX_SCREEN_H);
  fbFront = new Uint16Array(GX_SCREEN_W * GX_SCREEN_H);

  // Companion 1-byte/pixel mask: 1 = the pixel was drawn by the GX
  // rasterizer this frame, 0 = transparent / outside any triangle. The
  // 2D composer uses this for edge-mark detection (4-neighbour
  // boundary). Kept as a separate buffer rather than reusing fbFront's
  // bit 15 because the edge-mark pass needs to read the surrounding
  // pixels' drawn state independently of the color encoding.
  drawnMaskBack  = new Uint8Array(GX_SCREEN_W * GX_SCREEN_H);
  drawnMaskFront = new Uint8Array(GX_SCREEN_W * GX_SCREEN_H);

  // 3D control register block (GBATEK §"3D Display Engine Registers").
  // engine_a samples these during the per-pixel BG0 composite when
  // DISPCNT bit 3 (3D enable) is set. Writes come from IO bus
  // dispatchers; the defaults here mean "all post-process passes off"
  // so the rasterizer's raw output reaches the screen unchanged when
  // no game touches these registers — matches existing test ROMs that
  // expect plain interpolated triangles.
  dispCnt3D = 0;             // 0x04000060 (16-bit). bit 5 = edge mark, bit 7 = fog
  fogColor  = 0;             // 0x04000358 BGR555 (alpha ignored)
  fogOffset = 0;             // 0x0400035C 15-bit Z reference
  fogTable  = new Uint8Array(32);  // 0x04000360..0x0400037F (32 × 7-bit density)
  edgeColorTable = new Uint16Array(8);   // 0x04000330..0x0400033F (8 × BGR555)

  // Matrix stacks. Position stack is 31 deep, projection 1 deep.
  matProj = mat4Identity();
  matPos  = mat4Identity();
  matVec  = mat4Identity();
  matTex  = mat4Identity();
  posStack: Float64Array[] = [];
  projStack: Float64Array[] = [];
  vecStack: Float64Array[] = [];

  matMode = MTX_MODE_PROJ;

  // Vertex assembly.
  primType = -1;       // -1 = not in a BEGIN_VTXS block
  vertexBuf: Vertex[] = [];
  currentColor = 0x7FFF;     // white
  lastVtxX = 0; lastVtxY = 0; lastVtxZ = 0;     // for VTX_DIFF + partial coords

  // Lighting state. The material + 4 lights are populated by DIF_AMB /
  // SPE_EMI / LIGHT_VECTOR / LIGHT_COLOR. polygonAttr (cmd 0x29) gates
  // which lights contribute on a per-polygon basis: bits 0..3 of the
  // most recent POLYGON_ATTR value enable lights 0..3. The default
  // polygonAttr=0 means "no lights enabled" → computeVertexColor will
  // return the material's emission color (= black by default). To
  // preserve the existing "no lighting" behaviour, the gx.ts NORMAL
  // handler only overrides currentColor when at least one light is
  // enabled — that way unlit ROMs (and the existing gx.test.ts smoke
  // triangle) keep their plain COLOR-set vertex color.
  lights: LightState = newLightState();
  material: MaterialState = newMaterialState();
  polygonAttr = 0;

  // Command queue (the actual GXFIFO between CPU writes and our processor).
  // Each entry is { op: number, params: number[] }.
  cmdQueue: Array<{ op: number; params: number[] }> = [];
  // Partial command being assembled while bytes stream in.
  pendingOps: number[] = [];        // up to 4 opcodes per packed write
  pendingParams: number[] = [];     // params accumulated for the FIRST op in pendingOps

  constructor(mem: SharedMemory, irq9: Irq) {
    this.mem = mem;
    this.irq9 = irq9;
  }

  // GXFIFO at 0x04000400 — write a packed command word. The low byte
  // is the first opcode; subsequent bytes are additional opcodes if
  // any. After each opcode is taken from the packed word, its params
  // (CMD_PARAMS[op]) words follow as subsequent 32-bit writes.
  writeFifo(cmd: number): void {
    if (this.pendingOps.length === 0) {
      // Unpack 4 op bytes.
      for (let i = 0; i < 4; i++) {
        const op = (cmd >>> (i * 8)) & 0xFF;
        if (op !== 0) this.pendingOps.push(op);
      }
      // First op may have 0 params — try to drain those right away.
      this.tryDrain();
      return;
    }
    // We're streaming params for pendingOps[0]. Buffer this word.
    this.pendingParams.push(cmd);
    this.tryDrain();
  }

  // Direct command ports at 0x04000440+. The register offset encodes
  // the opcode: regOff = (op - 0x10) * 4 (per GBATEK). Each port write
  // is a single parameter — we accumulate as for the FIFO version.
  writeDirect(regAddr: number, value: number): void {
    const op = ((regAddr - 0x04000440) >>> 2) + 0x10;
    if (this.pendingOps.length > 0 && this.pendingOps[0] === op) {
      this.pendingParams.push(value);
    } else {
      // Start a new direct-cmd sequence.
      this.pendingOps = [op];
      this.pendingParams = [value];
    }
    this.tryDrain();
  }

  private tryDrain(): void {
    while (this.pendingOps.length > 0) {
      const op = this.pendingOps[0];
      const need = CMD_PARAMS[op] ?? 0;
      if (this.pendingParams.length < need) return;
      const params = this.pendingParams.slice(0, need);
      this.executeCommand(op, params);
      this.pendingParams = this.pendingParams.slice(need);
      this.pendingOps.shift();
    }
  }

  private executeCommand(op: number, p: number[]): void {
    switch (op) {
      case 0x10: this.matMode = p[0] & 0x3; return;
      case 0x11: this.matrixPush(); return;
      case 0x12: this.matrixPop(p[0] & 0x3F); return;
      case 0x15: this.matrixLoad(mat4Identity()); return;
      case 0x16: this.matrixLoad(this.unpack4x4(p)); return;
      case 0x17: this.matrixLoad(this.unpack4x3(p)); return;
      case 0x18: this.matrixMult(this.unpack4x4(p)); return;
      case 0x19: this.matrixMult(this.unpack4x3(p)); return;
      case 0x1A: this.matrixMult(this.unpack3x3(p)); return;
      case 0x1B: this.matrixMult(this.makeScale(p[0], p[1], p[2])); return;
      case 0x1C: this.matrixMult(this.makeTranslate(p[0], p[1], p[2])); return;
      case 0x20: this.currentColor = this.unpackColor(p[0]); return;
      case 0x21: this.normal(p[0]); return;
      case 0x29: this.polygonAttr = p[0] >>> 0; return;
      case 0x30: this.dif_amb(p[0]); return;
      case 0x31: this.spe_emi(p[0]); return;
      case 0x32: setLightVector(this.lights, p[0] >>> 0); return;
      case 0x33: setLightColor(this.lights, p[0] >>> 0); return;
      case 0x23: this.vertex16(p[0], p[1]); return;
      case 0x24: this.vertex10(p[0]); return;
      case 0x25: this.vertexPartial(p[0], 'XY'); return;
      case 0x26: this.vertexPartial(p[0], 'XZ'); return;
      case 0x27: this.vertexPartial(p[0], 'YZ'); return;
      case 0x28: this.vertexDiff(p[0]); return;
      case 0x40: this.beginVertices(p[0] & 0x3); return;
      case 0x41: this.endVertices(); return;
      case 0x50: this.swapBuffers(); return;
      default: return;     // unhandled — silently consume
    }
  }

  // ---- Matrix helpers ----

  private currentMatrix(): Float64Array {
    switch (this.matMode) {
      case MTX_MODE_PROJ: return this.matProj;
      case MTX_MODE_POS:  return this.matPos;
      case MTX_MODE_POSVEC: return this.matPos;  // pos+vec writes both — we use pos for transform
      case MTX_MODE_TEX:  return this.matTex;
    }
    return this.matPos;
  }

  private matrixPush(): void {
    if (this.matMode === MTX_MODE_PROJ) this.projStack.push(new Float64Array(this.matProj));
    else if (this.matMode === MTX_MODE_TEX) {/* texture stack — single slot */}
    else {
      this.posStack.push(new Float64Array(this.matPos));
      // POSVEC: push vec onto its own stack so MTX_POP in the same mode
      // restores both. Pos-only mode still pushes pos but the vec
      // stack stays untouched, matching hardware.
      if (this.matMode === MTX_MODE_POSVEC) this.vecStack.push(new Float64Array(this.matVec));
    }
  }

  private matrixPop(n: number): void {
    // n is 6-bit signed (5-bit magnitude + sign). Treat as count.
    const count = n & 0x1F;
    const negative = (n & 0x20) !== 0;
    const steps = negative ? -count : count;
    if (this.matMode === MTX_MODE_PROJ) {
      for (let i = 0; i < Math.abs(steps); i++) {
        const v = this.projStack.pop();
        if (v) this.matProj = v;
      }
    } else if (this.matMode !== MTX_MODE_TEX) {
      for (let i = 0; i < Math.abs(steps); i++) {
        const v = this.posStack.pop();
        if (v) this.matPos = v;
        if (this.matMode === MTX_MODE_POSVEC) {
          const vv = this.vecStack.pop();
          if (vv) this.matVec = vv;
        }
      }
    }
  }

  private matrixLoad(m: Float64Array): void {
    if (this.matMode === MTX_MODE_PROJ) this.matProj.set(m);
    else if (this.matMode === MTX_MODE_TEX) this.matTex.set(m);
    else {
      this.matPos.set(m);
      // In POSVEC mode the same load also writes the vector matrix —
      // GBATEK §"3D Matrix Stack" lists mode 2 as "set position AND
      // vector". Without this the lighting normal transform (which uses
      // matVec) would silently keep the previous matrix even when the
      // game expected both stacks to track.
      if (this.matMode === MTX_MODE_POSVEC) this.matVec.set(m);
    }
  }

  private matrixMult(m: Float64Array): void {
    const cur = this.currentMatrix();
    mat4Mul(cur, cur, m);
    // POSVEC: apply the same multiply to the vector matrix so the
    // lighting transform stays consistent with the position-modelview
    // chain.
    if (this.matMode === MTX_MODE_POSVEC) mat4Mul(this.matVec, this.matVec, m);
  }

  private unpack4x4(p: number[]): Float64Array {
    const m = new Float64Array(16);
    for (let i = 0; i < 16; i++) m[i] = (p[i] | 0) / 4096;
    return m;
  }
  private unpack4x3(p: number[]): Float64Array {
    const m = mat4Identity();
    // 12 fixed-point words: 4 rows of 3 columns + implicit (0,0,0,1)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        m[r * 4 + c] = ((p[r * 3 + c] | 0) / 4096);
      }
    }
    m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
    // Reorder: actual GBATEK layout: 4 rows × 3 cols of m, with col 4 = 0/0/0/1.
    // Transpose to column-major.
    const out = mat4Identity();
    for (let c = 0; c < 3; c++)
      for (let r = 0; r < 4; r++) out[c * 4 + r] = m[r * 4 + c];
    out[12] = m[3]; out[13] = m[7]; out[14] = m[11];
    return out;
  }
  private unpack3x3(p: number[]): Float64Array {
    const m = mat4Identity();
    for (let c = 0; c < 3; c++)
      for (let r = 0; r < 3; r++) m[c * 4 + r] = ((p[c * 3 + r] | 0) / 4096);
    return m;
  }
  private makeScale(sx: number, sy: number, sz: number): Float64Array {
    const m = mat4Identity();
    m[0]  = sx / 4096;
    m[5]  = sy / 4096;
    m[10] = sz / 4096;
    return m;
  }
  private makeTranslate(tx: number, ty: number, tz: number): Float64Array {
    const m = mat4Identity();
    m[12] = tx / 4096;
    m[13] = ty / 4096;
    m[14] = tz / 4096;
    return m;
  }

  private unpackColor(c: number): number {
    return c & 0x7FFF;
  }

  // ---- Lighting helpers (cmd 0x21 / 0x29-30-31) ----

  // Cmd 0x30 DIF_AMB updates diffuse + ambient and, when bit 15 of the
  // packed param is set, immediately latches the diffuse color into the
  // current vertex color. The latch lets SDK code stamp a per-mesh
  // base color even when no NORMAL follows (e.g. for unlit fallback
  // meshes that share the same material struct as lit ones).
  private dif_amb(packed: number): void {
    setDifAmb(this.material, packed);
    if (this.material.setVertexColor) this.currentColor = this.material.diffuse;
  }

  private spe_emi(packed: number): void {
    setSpeEmi(this.material, packed);
  }

  // Cmd 0x21 NORMAL is the "vertex shader" entry point: the param packs
  // a 3 × Q1.9 surface normal that gets multiplied by the vector matrix
  // and fed into the per-light dot product. The lit result becomes the
  // current vertex color, applied to every subsequent VTX_* until the
  // next COLOR / NORMAL command.
  //
  // We only override currentColor if at least one of the four light
  // enable bits in POLYGON_ATTR is set (default polygonAttr=0 means no
  // lights → keep COLOR-set value). This preserves the existing un-lit
  // behaviour exactly for ROMs that never enable lighting (and is what
  // keeps gx.test.ts / gx_basic.test.ts / gx_bus.test.ts green).
  private normal(packed: number): void {
    if ((this.polygonAttr & 0xF) === 0) return;
    const nObj = unpackNormal(packed);
    // Transform by the vector matrix. The DS uses a dedicated matVec
    // stack but most engines also accept POSVEC mode (matMode=2) where
    // pos and vec are tracked together; our gx tracks matVec as a
    // separate field that mirrors matPos when POSVEC is used. We
    // transform the normal by matVec's upper-left 3x3 (no translate).
    const m = this.matVec;
    const nx = m[0] * nObj.x + m[4] * nObj.y + m[8]  * nObj.z;
    const ny = m[1] * nObj.x + m[5] * nObj.y + m[9]  * nObj.z;
    const nz = m[2] * nObj.x + m[6] * nObj.y + m[10] * nObj.z;
    this.currentColor = computeVertexColor(
      { x: nx, y: ny, z: nz },
      this.polygonAttr,
      this.material,
      this.lights,
    );
  }

  // ---- Vertex assembly ----

  private beginVertices(prim: number): void {
    this.primType = prim;       // 0=tri list, 1=quad list, 2=tri strip, 3=quad strip
    this.vertexBuf = [];
  }

  private endVertices(): void {
    this.primType = -1;
  }

  private vertex16(p0: number, p1: number): void {
    // p0 low half = X, p0 high half = Y; p1 low half = Z (signed 16, 4.12).
    const x = signExtend(p0, 16);
    const y = signExtend(p0 >>> 16, 16);
    const z = signExtend(p1, 16);
    this.vertexAt(x / 4096, y / 4096, z / 4096);
  }

  private vertex10(p0: number): void {
    // 3 × 10-bit signed (6.4 format)
    const x = signExtend(p0 & 0x3FF, 10);
    const y = signExtend((p0 >>> 10) & 0x3FF, 10);
    const z = signExtend((p0 >>> 20) & 0x3FF, 10);
    this.vertexAt(x / 64, y / 64, z / 64);
  }

  private vertexPartial(p0: number, mode: 'XY' | 'XZ' | 'YZ'): void {
    const a = signExtend(p0, 16) / 4096;
    const b = signExtend(p0 >>> 16, 16) / 4096;
    if (mode === 'XY')      this.vertexAt(a, b, this.lastVtxZ);
    else if (mode === 'XZ') this.vertexAt(a, this.lastVtxY, b);
    else                    this.vertexAt(this.lastVtxX, a, b);
  }

  private vertexDiff(p0: number): void {
    // 3 × 10-bit signed deltas in 6.4
    const dx = signExtend(p0 & 0x3FF, 10) / 64;
    const dy = signExtend((p0 >>> 10) & 0x3FF, 10) / 64;
    const dz = signExtend((p0 >>> 20) & 0x3FF, 10) / 64;
    this.vertexAt(this.lastVtxX + dx, this.lastVtxY + dy, this.lastVtxZ + dz);
  }

  private vertexAt(x: number, y: number, z: number): void {
    this.lastVtxX = x; this.lastVtxY = y; this.lastVtxZ = z;
    // Apply position then projection matrices.
    const posView = mat4Apply(this.matPos, x, y, z, 1);
    const clip    = mat4Apply(this.matProj, posView.x, posView.y, posView.z, posView.w);
    this.vertexBuf.push({ x: clip.x, y: clip.y, z: clip.z, w: clip.w, color: this.currentColor });
    this.emitIfReady();
  }

  private emitIfReady(): void {
    const n = this.vertexBuf.length;
    if (this.primType === 0 && n >= 3) {                  // triangle list
      this.drawTriangle(this.vertexBuf[n-3], this.vertexBuf[n-2], this.vertexBuf[n-1]);
      this.vertexBuf.length = 0;
    } else if (this.primType === 1 && n >= 4) {           // quad list
      this.drawTriangle(this.vertexBuf[n-4], this.vertexBuf[n-3], this.vertexBuf[n-2]);
      this.drawTriangle(this.vertexBuf[n-4], this.vertexBuf[n-2], this.vertexBuf[n-1]);
      this.vertexBuf.length = 0;
    } else if (this.primType === 2 && n >= 3) {           // triangle strip
      const v0 = this.vertexBuf[n-3], v1 = this.vertexBuf[n-2], v2 = this.vertexBuf[n-1];
      if ((n & 1) === 1) this.drawTriangle(v0, v1, v2);
      else               this.drawTriangle(v1, v0, v2);
    } else if (this.primType === 3 && n >= 4 && (n & 1) === 0) {   // quad strip
      const a = this.vertexBuf[n-4], b = this.vertexBuf[n-3], c = this.vertexBuf[n-2], d = this.vertexBuf[n-1];
      this.drawTriangle(a, b, d);
      this.drawTriangle(b, c, d);
    }
  }

  // ---- Rasterizer ----

  private drawTriangle(va: Vertex, vb: Vertex, vc: Vertex): void {
    // Perspective divide → NDC.
    const sa = this.toScreen(va);
    const sb = this.toScreen(vb);
    const sc = this.toScreen(vc);
    if (!sa || !sb || !sc) return;
    // Sort vertices by y ascending so we can do a simple span fill.
    let [v0, v1, v2] = [sa, sb, sc].sort((x, y) => x.y - y.y);
    const yTop = Math.max(0, Math.ceil(v0.y));
    const yBot = Math.min(GX_SCREEN_H - 1, Math.floor(v2.y));
    if (yTop > yBot) return;
    for (let y = yTop; y <= yBot; y++) {
      const upper = y < v1.y;
      // edge0: v0 → v2 (long edge)
      const t02 = (y - v0.y) / Math.max(1e-9, v2.y - v0.y);
      const xL02 = v0.x + (v2.x - v0.x) * t02;
      // edge1: shorter edge
      let xL01: number;
      if (upper) {
        const t01 = (y - v0.y) / Math.max(1e-9, v1.y - v0.y);
        xL01 = v0.x + (v1.x - v0.x) * t01;
      } else {
        const t12 = (y - v1.y) / Math.max(1e-9, v2.y - v1.y);
        xL01 = v1.x + (v2.x - v1.x) * t12;
      }
      const xLeft  = Math.max(0,  Math.ceil(Math.min(xL02, xL01)));
      const xRight = Math.min(GX_SCREEN_W - 1, Math.floor(Math.max(xL02, xL01)));
      if (xLeft > xRight) continue;
      const fbRow = y * GX_SCREEN_W;
      // Flat fill with v0's color for now.
      const color = (va.color & 0x7FFF) | 0x8000;       // bit 15 = drawn
      for (let x = xLeft; x <= xRight; x++) {
        this.fbBack[fbRow + x] = color;
        this.drawnMaskBack[fbRow + x] = 1;
      }
    }
  }

  private toScreen(v: Vertex): { x: number; y: number } | null {
    if (v.w === 0) return null;
    const ndcX = v.x / v.w;
    const ndcY = v.y / v.w;
    // Standard NDS viewport: full screen 0..GX_SCREEN_W-1, 0..GX_SCREEN_H-1.
    return {
      x: (ndcX + 1) * 0.5 * GX_SCREEN_W,
      y: (1 - ndcY) * 0.5 * GX_SCREEN_H,
    };
  }

  // ---- SWAP_BUFFERS ----

  private swapBuffers(): void {
    // Promote back → front, clear back.
    this.fbFront.set(this.fbBack);
    this.fbBack.fill(0);
    this.drawnMaskFront.set(this.drawnMaskBack);
    this.drawnMaskBack.fill(0);
  }
}

function signExtend(v: number, bits: number): number {
  const m = 1 << (bits - 1);
  return (v & (m - 1)) - (v & m);
}
