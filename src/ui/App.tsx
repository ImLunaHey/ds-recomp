import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Emulator } from '../emulator';
import { unitCodeName } from '../cart/header';
import { decodeBannerIcon, decodeBannerTitle } from '../cart/banner';
import { disasmArm } from '../cpu/disasm';
import { SCREEN_W, SCREEN_H } from '../ppu/ppu';

// Virtual control-pad button. ext=true → extKeyinput bit, otherwise
// keyinput bit. Uses Pointer events so mouse + touch both work and the
// setPointerCapture lets the user drag off the button without dropping
// the press (which previously caused stuck buttons).
function PadButton({
  label, ext, bit, pressButton, releaseButton, className = '',
}: {
  label: string;
  ext: boolean;
  bit: number;
  pressButton: (ext: boolean, bit: number) => void;
  releaseButton: (ext: boolean, bit: number) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`select-none touch-none rounded-full bg-zinc-700 active:bg-emerald-600 border border-zinc-500 text-zinc-100 font-mono font-bold ${className}`}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
        pressButton(ext, bit);
      }}
      onPointerUp={() => releaseButton(ext, bit)}
      onPointerCancel={() => releaseButton(ext, bit)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}

// Composite virtual control pad. D-pad on the left, ABXY diamond on the
// right, L/R as shoulder strips, START/SELECT bar in the middle.
function ControlPad({
  pressButton, releaseButton,
}: {
  pressButton: (ext: boolean, bit: number) => void;
  releaseButton: (ext: boolean, bit: number) => void;
}) {
  const btn = { pressButton, releaseButton };
  return (
    <div className="mt-3 grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
      {/* D-pad */}
      <div className="grid grid-cols-3 grid-rows-3 gap-1 w-32 h-32 justify-self-center">
        <span />
        <PadButton {...btn} label="↑" ext={false} bit={6} className="w-10 h-10 text-lg" />
        <span />
        <PadButton {...btn} label="←" ext={false} bit={5} className="w-10 h-10 text-lg" />
        <span />
        <PadButton {...btn} label="→" ext={false} bit={4} className="w-10 h-10 text-lg" />
        <span />
        <PadButton {...btn} label="↓" ext={false} bit={7} className="w-10 h-10 text-lg" />
        <span />
      </div>
      {/* Middle column — L/R shoulders + START/SELECT */}
      <div className="flex flex-col items-center gap-2">
        <div className="flex gap-2">
          <PadButton {...btn} label="L" ext={false} bit={9} className="w-12 h-7 text-xs" />
          <PadButton {...btn} label="R" ext={false} bit={8} className="w-12 h-7 text-xs" />
        </div>
        <div className="flex gap-2">
          <PadButton {...btn} label="SEL" ext={false} bit={2} className="w-12 h-7 text-[10px]" />
          <PadButton {...btn} label="STA" ext={false} bit={3} className="w-12 h-7 text-[10px]" />
        </div>
      </div>
      {/* ABXY — diamond */}
      <div className="grid grid-cols-3 grid-rows-3 gap-1 w-32 h-32 justify-self-center">
        <span />
        <PadButton {...btn} label="X" ext={true}  bit={0} className="w-10 h-10 text-base" />
        <span />
        <PadButton {...btn} label="Y" ext={true}  bit={1} className="w-10 h-10 text-base" />
        <span />
        <PadButton {...btn} label="A" ext={false} bit={0} className="w-10 h-10 text-base" />
        <span />
        <PadButton {...btn} label="B" ext={false} bit={1} className="w-10 h-10 text-base" />
        <span />
      </div>
    </div>
  );
}

// Built-in ROMs that ship in public/. The .nds files themselves are
// gitignored — users add their own copies.
// ROM list grouped into Retail (commercial games) and Tests (homebrew /
// targeted PPU regression demos). Each entry can carry an emoji hint of
// how far the game currently boots in our emulator — "🟢" = visible
// title/content, "🟡" = boots past SDK init / runs internal state but
// no visible content, "🔴" = stalls or panics very early. Hints are
// best-effort snapshots and will drift as fixes land.
const BUILTIN_ROMS = [
  // Retail
  { label: 'Super Mario 64 DS', path: '/Super Mario 64 DS.nds',                            kind: 'retail', hint: '🟢' },
  { label: 'Brain Training',    path: '/Brain Training.nds',                               kind: 'retail', hint: '🟢' },
  { label: 'LEGO Star Wars',    path: '/LEGO Star Wars - The Complete Saga (USA).nds',     kind: 'retail', hint: '🟡' },
  { label: 'Pokemon Platinum',  path: '/Pokemon - Platinum Version (USA) (Rev 1).nds',     kind: 'retail', hint: '🟡' },
  { label: 'Pokemon HeartGold', path: '/Pokemon - HeartGold Version (USA).nds',            kind: 'retail', hint: '🟡' },
  { label: 'NSMB',              path: '/New Super Mario Bros.nds',                         kind: 'retail', hint: '🟡' },
  { label: 'Nintendogs',        path: '/Nintendogs - Labrador.nds',                        kind: 'retail', hint: '🟡' },
  { label: 'Tetris DS',         path: '/Tetris DS.nds',                                    kind: 'retail', hint: '🟡' },
  { label: 'Meteos',            path: '/Meteos.nds',                                       kind: 'retail', hint: '🔴' },
  // Homebrew / PPU regression tests
  { label: 'RockWrestler',      path: '/rockwrestler.nds',                                 kind: 'test',   hint: '' },
  { label: 'obj mosaic',        path: '/test_obj_mosaic.nds',                              kind: 'test',   hint: '' },
  { label: 'obj priority',      path: '/test_obj_prio.nds',                                kind: 'test',   hint: '' },
  { label: 'obj mosaic fuzz',   path: '/test_obj_mos_fuzz.nds',                            kind: 'test',   hint: '' },
] as const;
const STORAGE_KEY_ROM = 'ds-recomp:selectedRom';
function pickInitialRom(): string {
  if (typeof window === 'undefined') return BUILTIN_ROMS[0].path;
  const saved = window.localStorage?.getItem(STORAGE_KEY_ROM);
  if (saved && BUILTIN_ROMS.some((r) => r.path === saved)) return saved;
  return BUILTIN_ROMS[0].path;
}

// Render the Pokemon Platinum banner icon through the live BG0
// pipeline — real game graphics from the ROM, decoded via our
// banner parser and pushed into VRAM as 4bpp tiles for the
// scanline compositor to render.
function injectBannerThroughBg(emu: Emulator, romBytes: Uint8Array): void {
  if (!emu.header) return;
  const bannerOff = emu.header.bannerOffset;
  if (bannerOff === 0 || bannerOff + 0x340 > romBytes.length) return;

  const pram = emu.mem.pram;
  const vram = emu.mem.vram;

  // Banner palette (16 BGR555 entries at bannerOff+0x220) → engine A PRAM[0..15].
  for (let i = 0; i < 16; i++) {
    pram[i * 2]     = romBytes[bannerOff + 0x220 + i * 2];
    pram[i * 2 + 1] = romBytes[bannerOff + 0x220 + i * 2 + 1];
  }

  // The icon is 16 tiles (8×8 4bpp), stored sequentially at bannerOff+0x20.
  // Each tile = 32 bytes. We blit them into BG0's tile-data window
  // starting at tile index 1 (tile 0 = blank/transparent).
  // Tile data base for BG0 = char base (BGxCNT bits 2:3 = 0) → vram[0].
  for (let i = 0; i < 16 * 32; i++) {
    vram[32 + i] = romBytes[bannerOff + 0x20 + i];
  }

  // Tile map at screen-base 0x800 (BGxCNT bits 8..12 = 1). Place the
  // 4×4 icon centered horizontally around tile column 14 (px 112),
  // vertical band starting at row 10 (px 80). Around it, blank tile 0.
  const mapBase = 0x800;
  for (let i = 0; i < 32 * 32 * 2; i++) vram[mapBase + i] = 0;
  const iconCol = 14, iconRow = 10;
  // Banner icon tiles are laid out as 4×4 (row-major). We place them
  // four times at slightly different positions to fill more of the
  // screen and verify multi-tile-region sampling.
  const placements: Array<[number, number]> = [
    [iconCol, iconRow], [iconCol + 8, iconRow], [iconCol, iconRow + 8], [iconCol + 8, iconRow + 8],
  ];
  for (const [cx, cy] of placements) {
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        const tileNum = 1 + (dy * 4 + dx);   // 1..16
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || tx >= 32 || ty < 0 || ty >= 32) continue;
        const off = mapBase + (ty * 32 + tx) * 2;
        vram[off]     = tileNum & 0xFF;
        vram[off + 1] = (tileNum >> 8) & 0xFF;
      }
    }
  }

  emu.ppu.dispcntA = 0x00010100;     // displayMode 1, BG mode 0, BG0 on
  emu.ppu.bgCntA[0] = 0x0100;        // char base 0, screen base 1
  emu.ppu.bgHofsA[0] = 0;
  emu.ppu.bgVofsA[0] = 0;
}

// Stuff Engine A's BG0 with a recognizable pattern so the renderer can
// be smoke-tested even when the running game never gets to DISPCNT.
function injectTestPattern(emu: Emulator): void {
  // Engine A palette (16 colors @ 0x05000000). BGR555.
  const pram = emu.mem.pram;
  const setPal = (i: number, c: number) => {
    pram[i * 2]     = c & 0xFF;
    pram[i * 2 + 1] = (c >> 8) & 0xFF;
  };
  setPal(0, 0x0000);                    // backdrop (transparent index)
  setPal(1, 0x001F);                    // bright red (BGR555: B=0 G=0 R=31)
  setPal(2, 0x7FE0);                    // bright green
  setPal(3, 0x7C00);                    // bright blue
  setPal(4, 0x7FFF);                    // white
  setPal(5, 0x4210);                    // mid-grey

  // Engine A BG VRAM window starts at vram[0]. Tile #0 used as
  // "blank" (already zeros). Write tile #1 as a solid color index 1 (red).
  // 4bpp tile = 32 bytes; each byte holds two 4-bit pixels.
  const vram = emu.mem.vram;
  const blank = 0;
  for (let i = 0; i < 32; i++) vram[blank + i] = 0x00;
  for (let i = 0; i < 32; i++) vram[32 + i] = 0x11;       // tile 1: red
  for (let i = 0; i < 32; i++) vram[64 + i] = 0x22;       // tile 2: green
  for (let i = 0; i < 32; i++) vram[96 + i] = 0x33;       // tile 3: blue
  for (let i = 0; i < 32; i++) vram[128 + i] = 0x44;      // tile 4: white
  for (let i = 0; i < 32; i++) vram[160 + i] = 0x55;      // tile 5: grey
  // A "logo" tile: alternating index 1 / 4 making a checker.
  for (let row = 0; row < 8; row++) vram[192 + row * 4] = (row & 1) ? 0x14 : 0x41;
  for (let row = 0; row < 8; row++) vram[192 + row * 4 + 1] = (row & 1) ? 0x14 : 0x41;
  for (let row = 0; row < 8; row++) vram[192 + row * 4 + 2] = (row & 1) ? 0x14 : 0x41;
  for (let row = 0; row < 8; row++) vram[192 + row * 4 + 3] = (row & 1) ? 0x14 : 0x41;

  // Tile map (32×32 entries × 2 bytes) at engine A screen base 0x0800.
  // Layout: spell out colored bars + checker block.
  const mapBase = 0x800;
  for (let ty = 0; ty < 32; ty++) {
    for (let tx = 0; tx < 32; tx++) {
      let tile = 0;
      if (ty < 4) tile = 1;
      else if (ty < 8) tile = 2;
      else if (ty < 12) tile = 3;
      else if (ty < 16) tile = 4;
      else if (ty < 20) tile = 5;
      else tile = 6;  // checker
      const idx = mapBase + (ty * 32 + tx) * 2;
      vram[idx]     = tile & 0xFF;
      vram[idx + 1] = (tile >> 8) & 0xFF;
    }
  }

  // DISPCNT_A: display mode 1 (graphics), BG mode 0, enable BG0,
  // char base 0 / screen base 0.
  emu.ppu.dispcntA = 0x00010100;
  // BG0CNT_A: char base 0 (bits 2:3 = 0), screen base 1 (bits 8..12 = 1
  // → 0x800), 4bpp, 256×256 size.
  emu.ppu.bgCntA[0] = 0x0100;
  emu.ppu.bgHofsA[0] = 0;
  emu.ppu.bgVofsA[0] = 0;
}

// Inject GX commands for a few colored triangles, then enable engine A
// BG0 as the 3D layer. Lets the user verify the 3D pipeline is wired
// end to end without needing a retail game to reach its GX calls.
function injectGxDemo(emu: Emulator): void {
  const cmd = (op: number, ...params: number[]): void => {
    emu.bus9.write32(0x04000400, op);
    for (const p of params) emu.bus9.write32(0x04000400, p);
  };
  const packXY = (x: number, y: number): number => {
    const lo = (Math.round(x * 4096) & 0xFFFF);
    const hi = (Math.round(y * 4096) & 0xFFFF) << 16;
    return (lo | hi) >>> 0;
  };
  // Identity matrices.
  cmd(0x10, 0); cmd(0x15);
  cmd(0x10, 1); cmd(0x15);
  // Tri list.
  cmd(0x40, 0);
  // Triangle 1 — red, lower-left.
  cmd(0x20, 0x001F);
  cmd(0x23, packXY(-0.8, -0.6), 0);
  cmd(0x23, packXY(-0.2, -0.6), 0);
  cmd(0x23, packXY(-0.5,  0.0), 0);
  // Triangle 2 — green, lower-right.
  cmd(0x20, 0x03E0);
  cmd(0x23, packXY( 0.2, -0.6), 0);
  cmd(0x23, packXY( 0.8, -0.6), 0);
  cmd(0x23, packXY( 0.5,  0.0), 0);
  // Triangle 3 — blue, top.
  cmd(0x20, 0x7C00);
  cmd(0x23, packXY(-0.3,  0.2), 0);
  cmd(0x23, packXY( 0.3,  0.2), 0);
  cmd(0x23, packXY( 0.0,  0.7), 0);
  cmd(0x41);
  cmd(0x50, 0);
  // Engine A: graphics display mode 1, BG0 enabled, 3D bit (3) on.
  emu.ppu.dispcntA = (1 << 16) | (1 << 8) | (1 << 3);
  emu.ppu.bgCntA[0] = 0;            // priority 0
  // Black backdrop so the colors pop.
  emu.mem.pram[0] = 0; emu.mem.pram[1] = 0;
}

export function App() {
  const emuRef = useRef<Emulator | null>(null);
  if (!emuRef.current) emuRef.current = new Emulator();
  const emu = emuRef.current;

  const [romBytes, setRomBytes] = useState<Uint8Array | null>(null);
  const [src, setSrc] = useState<string>(pickInitialRom());
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [stats, setStats] = useState({ arm9: 0, arm7: 0, frame: 0, fps: 0 });

  const iconCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const topCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bottomCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const loadFromBytes = useCallback((buf: Uint8Array, label: string) => {
    try {
      emu.loadRom(buf);
      // RTC: switch from the deterministic test default to the actual
      // wall clock when running interactively. Games that gate behavior
      // on date changes (Brain Training, Pokemon) need this.
      emu.io7.rtc.dateProvider = () => new Date();
      // Restore save data from localStorage if present. Per-ROM key so
      // each game has its own slot. base64 since localStorage is text.
      try {
        const key = `ds-recomp:sav:${label}`;
        const enc = window.localStorage?.getItem(key);
        if (enc) {
          const bin = atob(enc);
          const sav = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) sav[i] = bin.charCodeAt(i);
          emu.cart.loadSav(sav);
        }
      } catch { /* ignore corrupt/oversize entries */ }
      setRomBytes(buf);
      setSrc(label);
      setError(null);
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [emu]);

  // Periodically persist the cart save back to localStorage when dirty.
  // Save chips write small amounts (a few KB typically); we just dump
  // the whole 1 MB blob each time — base64 makes it ~1.4 MB, well under
  // localStorage's 5 MB-per-origin browser limit. Frequency: every
  // ~3 seconds while the game's running, plus on tab unload.
  useEffect(() => {
    let lastDump = 0;
    const flush = (): void => {
      if (!emu.cart.savDirty) return;
      try {
        const key = `ds-recomp:sav:${src}`;
        const sav = emu.cart.sav;
        let bin = '';
        for (let i = 0; i < sav.length; i++) bin += String.fromCharCode(sav[i]);
        window.localStorage?.setItem(key, btoa(bin));
        emu.cart.savDirty = false;
      } catch { /* quota exceeded — skip silently */ }
    };
    const tick = (): void => {
      const now = performance.now();
      if (now - lastDump > 3000) {
        lastDump = now;
        flush();
      }
    };
    const interval = window.setInterval(tick, 1000);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [emu, src]);

  const loadBuiltin = useCallback(async (path: string) => {
    setRunning(false);
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`fetch ${path} → ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      loadFromBytes(buf, path);
      try { window.localStorage?.setItem(STORAGE_KEY_ROM, path); } catch { /* ignore quota */ }
      setRunning(true);    // autoplay
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [loadFromBytes]);

  // Initial fetch of the most-recently-used built-in ROM (or default).
  useEffect(() => {
    let cancelled = false;
    const path = pickInitialRom();
    (async () => {
      try {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`fetch ${path} → ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!cancelled) {
          loadFromBytes(buf, path);
          setRunning(true);    // autoplay on initial load
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [loadFromBytes]);

  // Paint icon when the loaded ROM changes.
  useEffect(() => {
    const cnv = iconCanvasRef.current;
    if (!cnv || !romBytes || !emu.header) return;
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    const rgba = decodeBannerIcon(romBytes, emu.header.bannerOffset);
    ctx.clearRect(0, 0, 32, 32);
    if (rgba) {
      const img = ctx.createImageData(32, 32);
      img.data.set(rgba);
      ctx.putImageData(img, 0, 0);
    }
  }, [tick, romBytes, emu.header]);

  const bannerTitle = useMemo(
    () => (romBytes && emu.header ? decodeBannerTitle(romBytes, emu.header.bannerOffset) : ''),
    [tick, romBytes, emu.header],
  );

  // ---- Keyboard + virtual control-pad → KEYINPUT / EXTKEYIN ----
  // NDS KEYINPUT bits are LOW when pressed. We keep a bitmask in refs so
  // BOTH the keyboard handler and the virtual control-pad buttons can
  // mutate the same state. apply() pushes the bitmask to io9 / io7.
  const keyinputRef = useRef(0x03FF);
  const extkeyRef = useRef(0x007F);
  const applyKeys = useCallback(() => {
    emu.io9.keyinput = keyinputRef.current;
    emu.io7.keyinput = keyinputRef.current;
    emu.io9.extKeyinput = extkeyRef.current;
    emu.io7.extKeyinput = extkeyRef.current;
  }, []);
  const pressButton = useCallback((ext: boolean, bit: number) => {
    if (ext) extkeyRef.current   &= ~(1 << bit);
    else     keyinputRef.current &= ~(1 << bit);
    applyKeys();
  }, [applyKeys]);
  const releaseButton = useCallback((ext: boolean, bit: number) => {
    if (ext) extkeyRef.current   |= (1 << bit);
    else     keyinputRef.current |= (1 << bit);
    applyKeys();
  }, [applyKeys]);
  useEffect(() => {
    // Map keyboard → NDS button bit. Bits below are bit positions in
    // keyinput (0..9) or extKeyinput (0..1, 6, 7). Returns null for keys
    // we don't handle.
    const bitFor = (k: string): { ext: boolean; bit: number } | null => {
      switch (k) {
        case 'z': case 'Z':       return { ext: false, bit: 0 };    // A
        case 'x': case 'X':       return { ext: false, bit: 1 };    // B
        case 'Shift':             return { ext: false, bit: 2 };    // Select
        case 'Enter':             return { ext: false, bit: 3 };    // Start
        case 'ArrowRight':        return { ext: false, bit: 4 };
        case 'ArrowLeft':         return { ext: false, bit: 5 };
        case 'ArrowUp':           return { ext: false, bit: 6 };
        case 'ArrowDown':         return { ext: false, bit: 7 };
        case 's': case 'S':       return { ext: false, bit: 8 };    // R
        case 'a': case 'A':       return { ext: false, bit: 9 };    // L
        case 'q': case 'Q':       return { ext: true,  bit: 0 };    // X
        case 'w': case 'W':       return { ext: true,  bit: 1 };    // Y
        default: return null;
      }
    };
    const onDown = (e: KeyboardEvent) => {
      const m = bitFor(e.key);
      if (!m) return;
      pressButton(m.ext, m.bit);
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      const m = bitFor(e.key);
      if (!m) return;
      releaseButton(m.ext, m.bit);
      e.preventDefault();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [emu]);

  // Main run loop. Each rAF: run one frame, paint both screens, sample stats.
  useEffect(() => {
    if (!running) return;
    let lastFpsCheck = performance.now();
    let framesAtLastCheck = emu.ppu.frameCount;
    let arm9Accum = 0, arm7Accum = 0;

    const loop = () => {
      try {
        const r = emu.runFrame();
        arm9Accum += r.arm9;
        arm7Accum += r.arm7;
        // POWCNT1 bit 15 controls which engine maps to which physical
        // screen. 1 = Engine A → top (default); 0 = Engine A → bottom.
        // Brain Training writes 0 here so its main HUD on Engine B
        // appears on the upper screen with touch UI on Engine A's
        // bottom screen.
        if ((emu.io9.powcnt1 >> 15) & 1) {
          paintCanvas(topCanvasRef.current, emu.ppu.fbA);
          paintCanvas(bottomCanvasRef.current, emu.ppu.fbB);
        } else {
          paintCanvas(topCanvasRef.current, emu.ppu.fbB);
          paintCanvas(bottomCanvasRef.current, emu.ppu.fbA);
        }
        const now = performance.now();
        if (now - lastFpsCheck > 500) {
          const fps = (emu.ppu.frameCount - framesAtLastCheck) / ((now - lastFpsCheck) / 1000);
          setStats({
            arm9: arm9Accum, arm7: arm7Accum, frame: emu.ppu.frameCount,
            fps: Math.round(fps * 10) / 10,
          });
          lastFpsCheck = now;
          framesAtLastCheck = emu.ppu.frameCount;
          arm9Accum = 0; arm7Accum = 0;
        }
        rafRef.current = requestAnimationFrame(loop);
      } catch (e) {
        setRunning(false);
        setError(`runtime: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, emu]);

  return (
    <div className="min-h-screen p-8 max-w-5xl mx-auto">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">ds-recomp</h1>
          <p className="text-sm text-zinc-400 mt-1">
            ARM9 + ARM7 interpreters, two-bus memory, IO routing, PPU scanline scheduler.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-40"
            disabled={!emu.header || running}
            onClick={() => setRunning(true)}
          >
            ▶ Run
          </button>
          <button
            className="px-4 py-2 rounded bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-semibold disabled:opacity-40"
            disabled={!running}
            onClick={() => setRunning(false)}
          >
            ⏸ Pause
          </button>
          <button
            className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm border border-zinc-700"
            onClick={() => {
              setRunning(false);
              if (romBytes) loadFromBytes(romBytes, src);
            }}
          >
            ⟲ Reset
          </button>
          <button
            className="px-4 py-2 rounded bg-indigo-700 hover:bg-indigo-600 text-white text-sm border border-indigo-500"
            title="Inject a tile-BG test pattern (verifies the 2D renderer end-to-end)"
            onClick={() => {
              injectTestPattern(emu);
              setTick((t) => t + 1);
              if (!running) {
                emu.ppu.frameDone = false;
                emu.ppu.step(355 * 263);
                paintCanvas(topCanvasRef.current, emu.ppu.fbA);
              }
            }}
          >
            🎨 Test Pattern
          </button>
          <button
            className="px-4 py-2 rounded bg-fuchsia-700 hover:bg-fuchsia-600 text-white text-sm border border-fuchsia-500 disabled:opacity-40"
            disabled={!romBytes || !emu.header}
            title="Decode the game's banner icon and render it through BG0 tiles"
            onClick={() => {
              if (!romBytes) return;
              injectBannerThroughBg(emu, romBytes);
              setTick((t) => t + 1);
              if (!running) {
                emu.ppu.frameDone = false;
                emu.ppu.step(355 * 263);
                paintCanvas(topCanvasRef.current, emu.ppu.fbA);
              }
            }}
          >
            🎮 Render Banner
          </button>
          <button
            className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-sm border border-emerald-500"
            title="Inject GX commands for a rotating triangle through the 3D engine"
            onClick={() => {
              injectGxDemo(emu);
              setTick((t) => t + 1);
              if (!running) {
                emu.ppu.frameDone = false;
                emu.ppu.step(355 * 263);
                paintCanvas(topCanvasRef.current, emu.ppu.fbA);
              }
            }}
          >
            🔺 3D Demo
          </button>
        </div>
      </header>

      <section
        className="border border-zinc-700 rounded-lg p-4 mb-6 bg-zinc-900"
        onDragOver={(e) => e.preventDefault()}
        onDrop={async (e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (!f) return;
          loadFromBytes(new Uint8Array(await f.arrayBuffer()), f.name);
        }}
      >
        <div className="mb-3">
          <div className="text-xs text-zinc-400 mb-1">Retail games</div>
          <div className="flex flex-wrap gap-1.5">
            {BUILTIN_ROMS.filter((r) => r.kind === 'retail').map((r) => (
              <button
                key={r.path}
                className={`px-2 py-1 rounded text-xs border whitespace-nowrap ${
                  src === r.path
                    ? 'bg-emerald-700 border-emerald-500 text-white'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
                }`}
                title={r.path}
                onClick={() => loadBuiltin(r.path)}
              >
                {r.hint && <span className="mr-1">{r.hint}</span>}
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mb-2">
          <div className="text-xs text-zinc-400 mb-1">Tests / homebrew</div>
          <div className="flex flex-wrap gap-1.5">
            {BUILTIN_ROMS.filter((r) => r.kind === 'test').map((r) => (
              <button
                key={r.path}
                className={`px-2 py-1 rounded text-xs border whitespace-nowrap ${
                  src === r.path
                    ? 'bg-emerald-700 border-emerald-500 text-white'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
                }`}
                title={r.path}
                onClick={() => loadBuiltin(r.path)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-zinc-400 mb-1">…or drag a <code>.nds</code> here.</p>
        <p className="text-xs text-zinc-500">
          Currently loaded: <code className="text-zinc-300">{src}</code>{' '}
          <span className="text-zinc-600">· 🟢 visible · 🟡 boots, no display · 🔴 stalls early</span>
        </p>
      </section>

      {error && (
        <div className="border border-red-700 bg-red-950/40 text-red-200 rounded p-3 mb-6 text-sm whitespace-pre-wrap">
          {error}
        </div>
      )}

      <section className="flex gap-6 mb-6">
        <div className="bg-black p-2 rounded">
          <canvas
            ref={topCanvasRef}
            width={SCREEN_W}
            height={SCREEN_H}
            className="block [image-rendering:pixelated]"
            style={{ width: SCREEN_W * 2, height: SCREEN_H * 2 }}
          />
          <div className="h-1" />
          <canvas
            ref={bottomCanvasRef}
            width={SCREEN_W}
            height={SCREEN_H}
            className="block [image-rendering:pixelated] cursor-crosshair touch-none"
            style={{ width: SCREEN_W * 2, height: SCREEN_H * 2 }}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
              const rect = e.currentTarget.getBoundingClientRect();
              emu.spi.touchX = Math.floor((e.clientX - rect.left) * SCREEN_W / rect.width);
              emu.spi.touchY = Math.floor((e.clientY - rect.top) * SCREEN_H / rect.height);
            }}
            onPointerMove={(e) => {
              if (emu.spi.touchX === null) return;
              const rect = e.currentTarget.getBoundingClientRect();
              emu.spi.touchX = Math.floor((e.clientX - rect.left) * SCREEN_W / rect.width);
              emu.spi.touchY = Math.floor((e.clientY - rect.top) * SCREEN_H / rect.height);
            }}
            onPointerUp={() => { emu.spi.touchX = null; emu.spi.touchY = null; }}
            onPointerCancel={() => { emu.spi.touchX = null; emu.spi.touchY = null; }}
          />
          {/* Virtual control pad — mirrors the keyboard mappings. Each
              button uses Pointer events with setPointerCapture so drags
              off the button don't drop mid-press. Long-press equivalent
              is just "hold the pointer". */}
          <ControlPad
            pressButton={pressButton}
            releaseButton={releaseButton}
          />
        </div>

        <div className="flex-1 min-w-0">
          {emu.header && emu.load && (
            <div className="border border-zinc-700 rounded-lg bg-zinc-900 p-4 mb-4">
              <div className="flex items-center gap-3 mb-3">
                <canvas
                  ref={iconCanvasRef}
                  width={32}
                  height={32}
                  className="border border-zinc-700 [image-rendering:pixelated]"
                  style={{ width: 48, height: 48 }}
                />
                <div>
                  <div className="text-sm font-semibold">{emu.header.title}</div>
                  <div className="text-[10px] text-zinc-400 font-mono">
                    {emu.header.gameCode} · {unitCodeName(emu.header.unitCode)}
                  </div>
                  {bannerTitle && (
                    <div className="text-[10px] text-zinc-300 mt-0.5 whitespace-pre-line">{bannerTitle.split(' / ')[0]}</div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] font-mono">
                <Row k="frame" v={String(stats.frame)} />
                <Row k="fps" v={String(stats.fps)} />
                <Row k="ARM9 insns/0.5s" v={stats.arm9.toLocaleString()} />
                <Row k="ARM7 insns/0.5s" v={stats.arm7.toLocaleString()} />
                <Row k="VCOUNT" v={String(emu.ppu.vcount)} />
                <Row k="DISPSTAT" v={hex16(emu.ppu.dispstat)} />
                <Row k="DISPCNT_A" v={hex32(emu.ppu.dispcntA)} />
                <Row k="DISPCNT_B" v={hex32(emu.ppu.dispcntB)} />
                <Row k="ARM9 PC" v={hex32(emu.cpu9.state.r[15])} />
                <Row k="ARM7 PC" v={hex32(emu.cpu7.state.r[15])} />
                <Row k="ARM9 CPSR" v={hex32(emu.cpu9.state.cpsr)} />
                <Row k="ARM7 CPSR" v={hex32(emu.cpu7.state.cpsr)} />
                <Row k="IE9 / IF9" v={`${hex32(emu.irq9.ie)} / ${hex32(emu.irq9.if_)}`} />
                <Row k="IE7 / IF7" v={`${hex32(emu.irq7.ie)} / ${hex32(emu.irq7.if_)}`} />
                <Row k="IME9 / IME7" v={`${emu.irq9.ime} / ${emu.irq7.ime}`} />
                <Row k="WRAMCNT" v={String(emu.mem.wramcnt)} />
                <Row k="IPC SYNC out 9/7" v={`${emu.ipc.sync9Out} / ${emu.ipc.sync7Out}`} />
                <Row k="IPC FIFO 9→7 / 7→9" v={`${emu.ipc.q9to7.size} / ${emu.ipc.q7to9.size}`} />
                {emu.overlays && (
                  <>
                    <Row k="overlays loaded" v={`${emu.overlays.arm9Loaded} (${emu.overlays.collisions} skipped)`} />
                    <Row k="overlay bytes" v={emu.overlays.arm9Bytes.toLocaleString()} />
                  </>
                )}
              </div>
            </div>
          )}

          {emu.header && (
            <div className="grid grid-cols-1 gap-3">
              <DisasmPanel
                title="ARM9 @ entry"
                base={emu.header.arm9EntryAddr}
                bytes={emu.readBlock9(emu.header.arm9EntryAddr, 48)}
              />
              <DisasmPanel
                title="ARM7 @ entry"
                base={emu.header.arm7EntryAddr}
                bytes={emu.readBlock7(emu.header.arm7EntryAddr, 48)}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function paintCanvas(cnv: HTMLCanvasElement | null, fb: Uint8ClampedArray): void {
  if (!cnv) return;
  const ctx = cnv.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(SCREEN_W, SCREEN_H);
  img.data.set(fb);
  ctx.putImageData(img, 0, 0);
}

function DisasmPanel({ title, base, bytes }: { title: string; base: number; bytes: Uint8Array }) {
  const rows: { addr: number; insn: number; text: string }[] = [];
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    const insn = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    rows.push({ addr: base + i, insn, text: disasmArm(insn, base + i) });
  }
  return (
    <div className="border border-zinc-700 rounded-lg bg-zinc-900 p-3">
      <h3 className="text-xs font-semibold text-zinc-300 mb-1.5">{title}</h3>
      <div className="font-mono text-[11px] space-y-0.5">
        {rows.map((r) => (
          <div key={r.addr} className="grid grid-cols-[8ch_8ch_1fr] gap-2">
            <span className="text-zinc-500">{hex32(r.addr)}</span>
            <span className="text-zinc-400">{hex32(r.insn).slice(2)}</span>
            <span className="text-zinc-200">{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="text-zinc-400">{k}</div>
      <div className="text-zinc-200">{v}</div>
    </>
  );
}

function hex32(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}
function hex16(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(4, '0');
}
