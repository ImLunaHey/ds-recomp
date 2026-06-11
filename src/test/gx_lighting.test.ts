// Unit tests for the per-vertex Gouraud lighting module. The tests
// exercise the math layer directly (no GX command stream) so failures
// localize to the lighting formula rather than the FIFO plumbing.

import { describe, it, expect } from 'vitest';
import {
  computeVertexColor,
  newLightState,
  newMaterialState,
  setLightVector,
  setLightColor,
  setDifAmb,
  unpackNormal,
} from '../ppu/gx_lighting';
import { Emulator } from '../emulator';

describe('gx_lighting — diffuse contribution', () => {
  it('identity-normal + 1 white light facing the surface = full diffuse color', () => {
    const lights = newLightState();
    const material = newMaterialState();
    // Light 0: vector points along +Z (toward viewer). With the GBATEK
    // -dot(N, L) convention, a normal facing -Z (away from viewer
    // towards the light source's negation) yields a positive dot, so
    // we use normal = (0, 0, -1) and light = (0, 0, +1) to mean "light
    // shining at the surface from straight ahead".
    setLightVector(lights, 0x3FF00000 >>> 0);    // light idx 0, x=0,y=0,z=1
    // Re-pack manually for clarity: z = 0x1FF (≈ +0.998 in Q1.9)
    lights.vectors[0] = 0; lights.vectors[1] = 0; lights.vectors[2] = 1;
    setLightColor(lights, 0x7FFF);               // white
    setDifAmb(material, 0x7FFF);                 // diffuse = white, ambient = 0
    // polygonAttr bit 0 = light 0 enabled.
    const color = computeVertexColor({ x: 0, y: 0, z: -1 }, 0x01, material, lights);
    // Should be (close to) white: every channel near 31.
    expect(color & 0x1F).toBeGreaterThan(27);
    expect((color >>> 5) & 0x1F).toBeGreaterThan(27);
    expect((color >>> 10) & 0x1F).toBeGreaterThan(27);
  });

  it('normal perpendicular to light = no diffuse contribution', () => {
    const lights = newLightState();
    const material = newMaterialState();
    lights.vectors[0] = 0; lights.vectors[1] = 0; lights.vectors[2] = 1;
    setLightColor(lights, 0x7FFF);
    setDifAmb(material, 0x7FFF);
    // Normal pointing along X — perpendicular to the light vector.
    // -dot = 0 → no diffuse term. With no ambient and no emission, the
    // color should be black (0).
    const color = computeVertexColor({ x: 1, y: 0, z: 0 }, 0x01, material, lights);
    expect(color).toBe(0);
  });

  it('normal pointing away from light = clamped to zero (no negative contribution)', () => {
    const lights = newLightState();
    const material = newMaterialState();
    lights.vectors[0] = 0; lights.vectors[1] = 0; lights.vectors[2] = 1;
    setLightColor(lights, 0x7FFF);
    setDifAmb(material, 0x7FFF);
    // Normal pointing toward the light's "source" direction → -dot is
    // negative, clamped to 0.
    const color = computeVertexColor({ x: 0, y: 0, z: 1 }, 0x01, material, lights);
    expect(color).toBe(0);
  });

  it('ambient term contributes independent of normal orientation', () => {
    const lights = newLightState();
    const material = newMaterialState();
    lights.vectors[0] = 0; lights.vectors[1] = 0; lights.vectors[2] = 1;
    setLightColor(lights, 0x7FFF);
    // diffuse = 0, ambient = white. The normal is perpendicular so
    // diffuse stays 0; ambient should still contribute.
    setDifAmb(material, 0x7FFF << 16);   // diffuse=0, ambient=white
    const color = computeVertexColor({ x: 1, y: 0, z: 0 }, 0x01, material, lights);
    // Ambient contribution: (aR=31 * lR=31) >> 5 = 30 per channel.
    expect(color & 0x1F).toBeGreaterThan(25);
  });

  it('multiple lights sum their contributions', () => {
    const lights = newLightState();
    const material = newMaterialState();
    // Two lights, each dim red. Both point toward the surface from +Z.
    lights.vectors[0] = 0; lights.vectors[1] = 0; lights.vectors[2] = 1;
    lights.vectors[3] = 0; lights.vectors[4] = 0; lights.vectors[5] = 1;
    // Light 0 dim red.
    lights.colors[0] = 0x000A;
    lights.colors[1] = 0x000A;
    setDifAmb(material, 0x7FFF);                              // white diffuse
    // Enable both lights, normal pointing toward surface.
    const oneLight = computeVertexColor({ x: 0, y: 0, z: -1 }, 0x01, material, lights);
    const twoLights = computeVertexColor({ x: 0, y: 0, z: -1 }, 0x03, material, lights);
    expect(twoLights & 0x1F).toBeGreaterThan(oneLight & 0x1F);
  });

  it('disabled lights contribute nothing — polygonAttr=0 returns emission only', () => {
    const lights = newLightState();
    const material = newMaterialState();
    lights.vectors[0] = 0; lights.vectors[1] = 0; lights.vectors[2] = 1;
    setLightColor(lights, 0x7FFF);
    setDifAmb(material, 0x7FFF);
    material.emission = 0x001F;                  // pure red emission
    // polygonAttr = 0 → no lights, no diffuse/ambient.
    const color = computeVertexColor({ x: 0, y: 0, z: -1 }, 0x00, material, lights);
    expect(color).toBe(0x001F);
  });

  it('emission term is always added, even without lights', () => {
    const lights = newLightState();
    const material = newMaterialState();
    material.emission = 0x7C00;                  // pure blue emission
    const color = computeVertexColor({ x: 0, y: 0, z: 0 }, 0x00, material, lights);
    expect(color).toBe(0x7C00);
  });
});

describe('gx_lighting — NORMAL command packing', () => {
  it('unpackNormal extracts three 10-bit signed Q1.9 values', () => {
    // x = 0x1FF (≈ +1.0), y = 0x000 (= 0), z = 0x200 (= -1.0)
    const packed = (0x1FF) | (0x000 << 10) | (0x200 << 20);
    const n = unpackNormal(packed >>> 0);
    expect(n.x).toBeCloseTo(0.998, 2);
    expect(n.y).toBeCloseTo(0, 5);
    expect(n.z).toBeCloseTo(-1, 5);
  });
});

describe('gx_lighting integration: GX FIFO produces lit vertex color', () => {
  it('single light + white diffuse + normal toward light = white vertex', () => {
    // Build a synthetic scene that drives the lighting via the actual
    // GX FIFO (so the wire-up in gx.ts is exercised too).
    const emu = new Emulator();
    const gx = emu.ppu.gx;
    const fifo = (op: number, ...params: number[]): void => {
      gx.writeFifo(op);
      for (const p of params) gx.writeFifo(p >>> 0);
    };
    // Identity proj + pos matrices.
    fifo(0x10, 0); fifo(0x15);
    fifo(0x10, 1); fifo(0x15);
    // Material: white diffuse, no ambient.
    fifo(0x30, 0x7FFF);
    // Light 0 vector pointing +Z (the surface→light direction).
    //   x=0, y=0, z=0x1FF (≈+1), idx=0
    fifo(0x32, (0x1FF << 20) >>> 0);
    // Light 0 color = white.
    fifo(0x33, 0x7FFF);
    // POLYGON_ATTR: enable light 0.
    fifo(0x29, 0x01);
    // Pre-load a red COLOR so we can see the lit result overrides it.
    fifo(0x20, 0x001F);
    // NORMAL pointing -Z (toward the light's source direction → -dot is
    // positive → full diffuse). z = 0x200 (= -1) in Q1.9.
    fifo(0x21, (0x200 << 20) >>> 0);
    // currentColor should now be approximately white.
    const lit = gx.currentColor;
    expect(lit & 0x1F).toBeGreaterThan(27);
    expect((lit >>> 5) & 0x1F).toBeGreaterThan(27);
    expect((lit >>> 10) & 0x1F).toBeGreaterThan(27);
    // And not the red we set with COLOR.
    expect(lit).not.toBe(0x001F);
  });

  it('NORMAL without any enabled light leaves currentColor untouched', () => {
    const emu = new Emulator();
    const gx = emu.ppu.gx;
    gx.writeFifo(0x10); gx.writeFifo(0); gx.writeFifo(0x15);
    gx.writeFifo(0x10); gx.writeFifo(1); gx.writeFifo(0x15);
    // COLOR = 0x1234.
    gx.writeFifo(0x20); gx.writeFifo(0x1234);
    // Issue NORMAL with polygonAttr still 0 (all lights disabled).
    gx.writeFifo(0x21); gx.writeFifo((0x200 << 20) >>> 0);
    // currentColor must be unchanged — gx must preserve the existing
    // no-lighting behaviour.
    expect(gx.currentColor).toBe(0x1234);
  });
});
