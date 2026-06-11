// Banner decoder tests. The banner format puts a 32x32 4bpp icon, a
// 16-entry BGR555 palette, and per-language UTF-16LE titles in a
// 0x340-byte block at header.bannerOffset.

import { describe, it, expect } from 'vitest';
import { decodeBannerIcon, decodeBannerTitle } from '../cart/banner';

// Build a fake ROM containing only the banner at the given offset.
function makeRomWithBanner(bannerOffset: number, build: (banner: Uint8Array) => void): Uint8Array {
  const rom = new Uint8Array(bannerOffset + 0x400);
  const banner = rom.subarray(bannerOffset, bannerOffset + 0x340);
  build(banner);
  return rom;
}

// Write a 16-bit value little-endian.
function w16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xFF;
  buf[off + 1] = (v >>> 8) & 0xFF;
}

describe('Banner icon decoder', () => {
  it('decodes a 4bpp tile blob into an RGBA buffer of the right size', () => {
    const rom = makeRomWithBanner(0x1000, (banner) => {
      // Header bytes 0..0x1F: version=1 etc (left zero; decoder doesn't
      // care for this minimal test).
      // Palette: entry 0 = transparent, entry 1 = pure red (BGR555 = R=31).
      // BGR555 layout in source: bits 0..4 = R, bits 5..9 = G, 10..14 = B.
      w16(banner, 0x220 + 1 * 2, 31); // entry 1: R=31 G=0 B=0
      // Bitmap at 0x20: paint a single pixel with palette index 1 at
      // top-left of tile 0 (which lives at icon coordinate 0,0).
      // The byte at 0x20 holds two pixels: low nibble = left, high =
      // right. We want left = 1, right = 0 → byte = 0x01.
      banner[0x20] = 0x01;
    });

    const out = decodeBannerIcon(rom, 0x1000);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(32 * 32 * 4);
    // Top-left pixel: palette index 1 → red.
    expect(out![0]).toBe(248);  // 31 * 8
    expect(out![1]).toBe(0);
    expect(out![2]).toBe(0);
    expect(out![3]).toBe(255);
    // Pixel (1, 0): palette index 0 → transparent (alpha 0).
    expect(out![7]).toBe(0);
  });

  it('returns null when bannerOffset is 0', () => {
    const rom = new Uint8Array(0x400);
    expect(decodeBannerIcon(rom, 0)).toBeNull();
    expect(decodeBannerTitle(rom, 0)).toBe('');
  });

  it('returns null when bannerOffset is past end of ROM (no crash)', () => {
    const rom = new Uint8Array(0x400);
    expect(decodeBannerIcon(rom, 0x800)).toBeNull();
    expect(decodeBannerTitle(rom, 0x800)).toBe('');
  });

  it('decodes the English title (UTF-16LE) up to the first NUL terminator', () => {
    const rom = makeRomWithBanner(0x1000, (banner) => {
      // Banner version 1 header (left zero).
      // English title at 0x240, UTF-16LE: "HELLO" then NUL terminator.
      const start = 0x240;
      const s = 'HELLO';
      for (let i = 0; i < s.length; i++) w16(banner, start + i * 2, s.charCodeAt(i));
      // explicit terminator follows (banner is zero-init).
    });

    const out = decodeBannerTitle(rom, 0x1000);
    expect(out).toBe('HELLO');
  });

  it('replaces 0x000A line separator with " / "', () => {
    const rom = makeRomWithBanner(0x1000, (banner) => {
      const start = 0x240;
      const parts = ['AB', 0x0A, 'CD'];
      let off = start;
      for (const p of parts) {
        if (typeof p === 'string') {
          for (let i = 0; i < p.length; i++) {
            w16(banner, off, p.charCodeAt(i));
            off += 2;
          }
        } else {
          w16(banner, off, p);
          off += 2;
        }
      }
    });

    const out = decodeBannerTitle(rom, 0x1000);
    expect(out).toBe('AB / CD');
  });
});
