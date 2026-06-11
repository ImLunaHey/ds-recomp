// DS 3D engine per-pixel fog + edge marking helpers (GBATEK §"3D Display
// Engine — Fog" and §"3D Display Engine — Edge Marking"). Both happen
// during 2D composition in engine_a.ts, AFTER the GX framebuffer has
// been built but BEFORE it's promoted onto BG0.
//
// Fog: each pixel's depth (Z) is mapped via FOG_TABLE (32 5-bit density
// entries) into a 0..127 density. The polygon color is blended toward
// FOG_COLOR by that density. Our rasterizer doesn't yet produce a real
// per-pixel Z, so the engine_a caller uses 0 (= "no depth", maps to
// FOG_TABLE[0]) for every pixel. Once a Z buffer lands, swap in the
// real Z per pixel — the API is already shaped for that.
//
// Edge marking: each "drawn" pixel is tagged with its source triangle's
// polygon-ID; where two adjacent pixels carry different IDs (and at
// least one is drawn), draw a colored 1-pixel edge using
// EDGE_COLOR_TABLE[id & 0x7]. Since our rasterizer doesn't yet emit
// polygon-IDs, the helper here operates on a binary "is drawn" mask:
// the edge of the rendered region against the surrounding undrawn area
// is what most games visually expose (cel-shaded outlines on opaque
// hero models). When the polygon-ID path lands this can be promoted
// from a binary discriminator to a multi-class one.

// Returned color is BGR555 (bit 15 may carry the "drawn" flag from the
// caller — we preserve it).
export function applyFog(
  color: number,
  z: number,
  fogTable: Uint8Array,
  fogOffset: number,
  fogColor: number,
): number {
  // Fog density is sampled from a 32-entry table, each entry 7-bit
  // (0..127). The table is indexed by the upper bits of (z - fogOffset)
  // saturating at 0 below the offset and at table-end above. Real
  // hardware uses a 15-bit shift step; with no real Z buffer we treat
  // `z` as a 0..0xFFFF value and bucket linearly into 32 slots.
  const relZ = z - fogOffset;
  let idx = relZ <= 0 ? 0 : (relZ >>> 11);     // 16-bit z → 32 buckets
  if (idx > 31) idx = 31;
  const density = fogTable[idx] & 0x7F;
  if (density === 0) return color;

  const drawnBit = color & 0x8000;
  const cr = color & 0x1F;
  const cg = (color >>> 5) & 0x1F;
  const cb = (color >>> 10) & 0x1F;
  const fr = fogColor & 0x1F;
  const fg = (fogColor >>> 5) & 0x1F;
  const fb = (fogColor >>> 10) & 0x1F;
  // density 0..127 → mix factor / 128. At density = 128 we'd be fully
  // fogged; the table caps at 127 so we approach the fog color but
  // never quite hit it — matches hardware behaviour.
  const d = density;
  const inv = 128 - d;
  const r = (cr * inv + fr * d) >> 7;
  const g = (cg * inv + fg * d) >> 7;
  const b = (cb * inv + fb * d) >> 7;
  return drawnBit | ((b << 10) | (g << 5) | r);
}

// Apply edge marking to a single pixel by sampling its 4-connected
// neighbours. If any neighbour is "undrawn" while the centre pixel is
// drawn (or vice versa), replace the centre color with `edgeColor`.
// Caller passes the indexed `drawnMask`: 1 = pixel drawn by GX, 0 = no
// 3D contribution at this pixel.
//
// `drawnMask` is laid out as a flat W×H Uint8Array.
export function applyEdgeMark(
  color: number,
  x: number,
  y: number,
  w: number,
  h: number,
  drawnMask: Uint8Array,
  edgeColor: number,
): number {
  const idx = y * w + x;
  const here = drawnMask[idx] !== 0;
  if (!here) return color;
  const left  = x > 0       ? drawnMask[idx - 1]      !== 0 : false;
  const right = x < w - 1   ? drawnMask[idx + 1]      !== 0 : false;
  const up    = y > 0       ? drawnMask[idx - w]      !== 0 : false;
  const down  = y < h - 1   ? drawnMask[idx + w]      !== 0 : false;
  // Edge condition: any 4-neighbour disagrees with the centre.
  if (left && right && up && down) return color;
  // Preserve the drawn bit so compositing still sees this as a real
  // pixel.
  return (color & 0x8000) | (edgeColor & 0x7FFF);
}
