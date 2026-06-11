// DS 3D engine per-vertex Gouraud lighting (GBATEK §"3D Display Engine —
// Lighting"). The vertex shader stage runs when NORMAL (cmd 0x21) is
// issued: the normal is transformed by the vector matrix (we use the
// position matrix as a stand-in — see comment in gx.ts), then each of
// the four hardware lights, if enabled by POLYGON_ATTR bits 0..3,
// contributes a diffuse and ambient term. The final per-vertex color
// becomes the current vertex color used by subsequent VTX_* commands.
//
// The DS color space is BGR555 (5 bits per channel, 0..31). All
// arithmetic happens in that space — diffuse * lightColor is computed
// component-wise as (a * b) >> 5 so the product stays in 0..31.
//
// Specular is intentionally NOT modelled here. Most retail DS games
// either disable specular entirely or rely on the highlight / toon
// tables, neither of which is exercised by the games we care about
// (SM64DS, Tony Hawk PG, Spider-Man, Cooking Mama, AoE). Adding it
// would require modelling the half-angle vector and a shininess LUT;
// the diffuse + ambient path is the dominant contributor and is what
// the "flat, no lighting" complaint in the issue refers to.

export const NUM_LIGHTS = 4;

// 5-bit-per-channel BGR555 color, packed as the DS encodes it:
//   bits 0..4   = red
//   bits 5..9   = green
//   bits 10..14 = blue
// Returned values from this module always have bit 15 clear.
export type Bgr555 = number;

export interface LightState {
  // Each light has a normalized direction vector pointing FROM the
  // surface TO the light, and an emission color. The vector is stored
  // in plain JS numbers (units already in Q1.9 / 512 = "1.0"). The
  // lighting math here normalizes against magnitude as needed.
  vectors: Float64Array;       // 12 floats: [x0,y0,z0, x1,y1,z1, ...]
  colors: Uint16Array;         // 4 BGR555 colors
}

export interface MaterialState {
  // Each is a packed BGR555. The "use as vertex color" bit (15 in
  // DIF_AMB) and the "use shininess table" bit (15 in SPE_EMI) are
  // mirrored into separate flags so the caller doesn't need to mask.
  diffuse: Bgr555;
  ambient: Bgr555;
  specular: Bgr555;
  emission: Bgr555;
  // When DIF_AMB bit 15 is set, the diffuse color also becomes the
  // immediate current vertex color (before any lighting). We don't
  // need to handle that side-effect here — gx.ts mirrors it onto its
  // currentColor field. Provided for completeness.
  setVertexColor: boolean;
}

export function newLightState(): LightState {
  return {
    vectors: new Float64Array(NUM_LIGHTS * 3),
    colors: new Uint16Array(NUM_LIGHTS),
  };
}

export function newMaterialState(): MaterialState {
  return {
    diffuse: 0,
    ambient: 0,
    specular: 0,
    emission: 0,
    setVertexColor: false,
  };
}

// Cmd 0x32 LIGHT_VECTOR.  Param layout per GBATEK:
//   bits  0..9  = X (10-bit signed Q1.9 — i.e. -1..+0.998 in steps of 1/512)
//   bits 10..19 = Y
//   bits 20..29 = Z
//   bits 30..31 = light index (0..3)
// The vector points FROM the surface TO the light's "infinity" position
// (it's a direction, not a position) — meaning to compute a diffuse
// contribution we use max(0, -dot(normal, lightVec)). On hardware the
// vector is also transformed by the current vector matrix before being
// stored; we treat that responsibility as upstream (gx.ts passes the
// transformed vector here).
export function setLightVector(state: LightState, packed: number): void {
  const idx = (packed >>> 30) & 0x3;
  const x = signExtend10(packed & 0x3FF) / 512;
  const y = signExtend10((packed >>> 10) & 0x3FF) / 512;
  const z = signExtend10((packed >>> 20) & 0x3FF) / 512;
  state.vectors[idx * 3 + 0] = x;
  state.vectors[idx * 3 + 1] = y;
  state.vectors[idx * 3 + 2] = z;
}

// Cmd 0x33 LIGHT_COLOR.  Param layout:
//   bits  0..14 = BGR555 color
//   bits 30..31 = light index (0..3)
export function setLightColor(state: LightState, packed: number): void {
  const idx = (packed >>> 30) & 0x3;
  state.colors[idx] = packed & 0x7FFF;
}

// Cmd 0x30 DIF_AMB.  Param layout:
//   bits  0..14 = diffuse BGR555
//   bit  15     = set the vertex color to diffuse immediately
//   bits 16..30 = ambient BGR555
export function setDifAmb(state: MaterialState, packed: number): void {
  state.diffuse = packed & 0x7FFF;
  state.ambient = (packed >>> 16) & 0x7FFF;
  state.setVertexColor = (packed & 0x8000) !== 0;
}

// Cmd 0x31 SPE_EMI.  Param layout:
//   bits  0..14 = specular BGR555
//   bit  15     = use shininess table (we don't model — ignored)
//   bits 16..30 = emission BGR555
export function setSpeEmi(state: MaterialState, packed: number): void {
  state.specular = packed & 0x7FFF;
  state.emission = (packed >>> 16) & 0x7FFF;
}

// Compute the lit vertex color for the given surface normal.
//
// `normal` is the 3-vector already transformed into the same space as
// the stored light vectors (caller's responsibility — see gx.ts). It
// should be roughly unit-length; we don't re-normalize here because the
// LIGHT_VECTOR encoding is also in [-1, +1) and on real hardware no
// normalization step happens — clipping at length>1 is fine and matches
// the hardware "overbright" behaviour the games rely on (rare).
//
// `polygonAttr` is the most recent POLYGON_ATTR (cmd 0x29) value; bits
// 0..3 enable lights 0..3 respectively. When all four bits are clear
// the function returns the material's emission color alone — but the
// caller (gx.ts) only invokes this on NORMAL, so a zero polygonAttr
// effectively means "lighting disabled → use emission ≈ black".
//
// Returned color is BGR555 in 0..0x7FFF.
export function computeVertexColor(
  normal: { x: number; y: number; z: number },
  polygonAttr: number,
  material: MaterialState,
  lights: LightState,
): Bgr555 {
  // Start with emission. Each channel is 0..31.
  let r = material.emission & 0x1F;
  let g = (material.emission >>> 5) & 0x1F;
  let b = (material.emission >>> 10) & 0x1F;

  const dR = material.diffuse & 0x1F;
  const dG = (material.diffuse >>> 5) & 0x1F;
  const dB = (material.diffuse >>> 10) & 0x1F;
  const aR = material.ambient & 0x1F;
  const aG = (material.ambient >>> 5) & 0x1F;
  const aB = (material.ambient >>> 10) & 0x1F;

  for (let i = 0; i < NUM_LIGHTS; i++) {
    if ((polygonAttr & (1 << i)) === 0) continue;
    const lvx = lights.vectors[i * 3 + 0];
    const lvy = lights.vectors[i * 3 + 1];
    const lvz = lights.vectors[i * 3 + 2];
    const lc = lights.colors[i];
    const lR = lc & 0x1F;
    const lG = (lc >>> 5) & 0x1F;
    const lB = (lc >>> 10) & 0x1F;

    // Diffuse term: max(0, -dot(normal, lightVec)). The light vector
    // points FROM surface TO light, so -dot is what gives the cosine
    // of the angle between the surface normal and the surface→light
    // direction (in the "light comes from this side" sense).
    //
    // GBATEK's clarification: the DS computes the dot product against
    // a "light vector direction" stored already-negated on hardware,
    // so the firmware's net effect is `max(0, -dot(N, L))`. We match
    // the GBATEK net formula.
    let diff = -(normal.x * lvx + normal.y * lvy + normal.z * lvz);
    if (diff < 0) diff = 0;
    // diff is now in [0, ~1]. Use 5-bit scale.
    const diffScaled = Math.min(31, Math.floor(diff * 32));

    // Ambient adds (ambient * lightColor) per channel, always.
    // Diffuse adds (diffuseColor * lightColor * diff) per channel.
    r += ((aR * lR) >> 5) + (((dR * lR) >> 5) * diffScaled >> 5);
    g += ((aG * lG) >> 5) + (((dG * lG) >> 5) * diffScaled >> 5);
    b += ((aB * lB) >> 5) + (((dB * lB) >> 5) * diffScaled >> 5);
  }

  if (r > 31) r = 31;
  if (g > 31) g = 31;
  if (b > 31) b = 31;
  if (r < 0) r = 0;
  if (g < 0) g = 0;
  if (b < 0) b = 0;
  return ((b << 10) | (g << 5) | r) & 0x7FFF;
}

// Cmd 0x21 NORMAL parameter layout:
//   bits  0..9  = X (10-bit signed Q1.9)
//   bits 10..19 = Y
//   bits 20..29 = Z
// Returns a plain {x, y, z} object in floating-point [-1, +0.998].
export function unpackNormal(packed: number): { x: number; y: number; z: number } {
  return {
    x: signExtend10(packed & 0x3FF) / 512,
    y: signExtend10((packed >>> 10) & 0x3FF) / 512,
    z: signExtend10((packed >>> 20) & 0x3FF) / 512,
  };
}

function signExtend10(v: number): number {
  return (v & 0x1FF) - (v & 0x200);
}
