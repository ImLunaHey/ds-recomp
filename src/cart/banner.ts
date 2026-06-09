// NDS banner decoder. The banner block (typically at header.bannerOffset)
// holds a 32×32 icon as 4bpp tiled pixels + a 16-color palette, plus
// title strings in several languages. We render just the icon here for
// the library tile.

const ICON_TILES = 16;        // 4×4 tile grid
const ICON_PIXELS_PER_AXIS = 32;

// Convert a 5-bit BGR555 palette entry to RGBA8888.
function bgr555ToRgba(c: number): [number, number, number, number] {
  const r = ((c >> 0) & 0x1F) * 8;
  const g = ((c >> 5) & 0x1F) * 8;
  const b = ((c >> 10) & 0x1F) * 8;
  return [r, g, b, 255];
}

// Decode the 32×32 icon to an RGBA8888 buffer (4096 bytes).
// Returns null if the banner is absent or out of range.
export function decodeBannerIcon(rom: Uint8Array, bannerOffset: number): Uint8ClampedArray | null {
  if (bannerOffset === 0 || bannerOffset + 0x340 > rom.length) return null;
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  // Bitmap: 0x20..0x21F (512 bytes of 4bpp pixels).
  // Palette: 0x220..0x23F (32 bytes = 16 BGR555 entries; entry 0 = transparent).
  const bitmapOff = bannerOffset + 0x20;
  const palOff    = bannerOffset + 0x220;
  const pal: number[] = [];
  for (let i = 0; i < 16; i++) pal.push(dv.getUint16(palOff + i * 2, true));

  const out = new Uint8ClampedArray(ICON_PIXELS_PER_AXIS * ICON_PIXELS_PER_AXIS * 4);
  // Icon is stored as 16 tiles of 8×8 in row-major order; each tile is
  // 32 bytes of 4bpp pixels (low nibble = left pixel).
  for (let tile = 0; tile < ICON_TILES; tile++) {
    const tileX = (tile & 3) * 8;
    const tileY = (tile >> 2) * 8;
    const tileOff = bitmapOff + tile * 32;
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px += 2) {
        const byte = rom[tileOff + py * 4 + (px >> 1)];
        const lo = byte & 0x0F;
        const hi = (byte >> 4) & 0x0F;
        for (let p = 0; p < 2; p++) {
          const idx = p === 0 ? lo : hi;
          const x = tileX + px + p;
          const y = tileY + py;
          const dst = (y * ICON_PIXELS_PER_AXIS + x) * 4;
          if (idx === 0) {
            // Transparent — keep zeros (alpha 0).
            continue;
          }
          const [r, g, b, a] = bgr555ToRgba(pal[idx]);
          out[dst + 0] = r;
          out[dst + 1] = g;
          out[dst + 2] = b;
          out[dst + 3] = a;
        }
      }
    }
  }
  return out;
}

// Pull the English game title from the banner (UTF-16LE, 256 bytes,
// title lines separated by 0x000A).
export function decodeBannerTitle(rom: Uint8Array, bannerOffset: number): string {
  if (bannerOffset === 0 || bannerOffset + 0x340 > rom.length) return '';
  // Banner version 1: English at offset 0x240. v2+ keep the same slot.
  const start = bannerOffset + 0x240;
  let out = '';
  for (let i = 0; i < 256; i += 2) {
    const c = rom[start + i] | (rom[start + i + 1] << 8);
    if (c === 0) break;
    if (c === 0x0A) out += ' / ';
    else out += String.fromCharCode(c);
  }
  return out;
}
