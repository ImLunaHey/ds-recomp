// Headless smoke test for the 3D engine: inject a triangle through
// the GXFIFO and verify it ends up in fbFront after SWAP_BUFFERS.
import { Emulator } from '../emulator';

const emu = new Emulator();
const gx = emu.ppu.gx;

// Helper: send a single command directly (bypasses CPU; routes to
// writeDirect, which is the cleaner path for hand-issued commands).
function cmd(op: number, params: number[] = []): void {
  // We use the GXFIFO unpacked path: opcode in low byte of a u32,
  // followed by params as u32 writes.
  gx.writeFifo(op);
  for (const p of params) gx.writeFifo(p);
}

// Set up identity matrices.
cmd(0x10, [0]);          // MTX_MODE = projection
cmd(0x15);               // MTX_IDENTITY
cmd(0x10, [1]);          // MTX_MODE = position
cmd(0x15);               // MTX_IDENTITY

// Begin a triangle list.
cmd(0x40, [0]);          // BEGIN_VTXS = tri list

// Set color (full red).
cmd(0x20, [0x001F]);     // BGR555: R=31, G=0, B=0

// Three vertices in NDC (4.12 fixed point).
// (-0.5, -0.5, 0), (0.5, -0.5, 0), (0, 0.5, 0)
function pack16(x: number, y: number): number {
  const lo = (Math.round(x * 4096) & 0xFFFF);
  const hi = (Math.round(y * 4096) & 0xFFFF) << 16;
  return (lo | hi) >>> 0;
}
function packZ(z: number): number {
  return (Math.round(z * 4096) & 0xFFFF);
}

cmd(0x23, [pack16(-0.5, -0.5), packZ(0)]);
cmd(0x23, [pack16( 0.5, -0.5), packZ(0)]);
cmd(0x23, [pack16( 0.0,  0.5), packZ(0)]);

cmd(0x41);               // END_VTXS
cmd(0x50, [0]);          // SWAP_BUFFERS

// Inspect fbFront.
let drawn = 0;
const colors = new Set<number>();
for (let i = 0; i < gx.fbFront.length; i++) {
  const v = gx.fbFront[i];
  if ((v & 0x8000) !== 0) { drawn++; colors.add(v & 0x7FFF); }
}
console.log(`fbFront drawn pixels: ${drawn}`);
console.log(`distinct colors: ${colors.size}`);
console.log(`sample colors: ${[...colors].slice(0, 5).map(c => '0x' + c.toString(16)).join(' ')}`);

// Roughly check the triangle area: 50% of half the screen ≈ ~6144 pixels
// for a triangle with vertices (-0.5,-0.5), (0.5,-0.5), (0,0.5).
console.log(`expected ~5000-7000 drawn pixels for a (-0.5,-0.5)-(0.5,-0.5)-(0,0.5) tri`);
