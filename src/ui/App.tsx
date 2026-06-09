import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Emulator } from '../emulator';
import { unitCodeName } from '../cart/header';
import { decodeBannerIcon, decodeBannerTitle } from '../cart/banner';
import { disasmArm } from '../cpu/disasm';
import { SCREEN_W, SCREEN_H } from '../ppu/ppu';

// Built-in ROMs that ship in public/. The .nds files themselves are
// gitignored — users add their own copies.
const BUILTIN_ROMS = [
  { label: 'Pokemon Platinum',  path: '/Pokemon - Platinum Version (USA) (Rev 1).nds' },
  { label: 'New Super Mario',   path: '/New Super Mario Bros.nds' },
  { label: 'Nintendogs',        path: '/Nintendogs - Labrador.nds' },
  { label: 'RockWrestler',      path: '/rockwrestler.nds' },
  { label: 'obj mosaic',        path: '/test_obj_mosaic.nds' },
  { label: 'obj priority',      path: '/test_obj_prio.nds' },
  { label: 'obj mosaic fuzz',   path: '/test_obj_mos_fuzz.nds' },
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
      setRomBytes(buf);
      setSrc(label);
      setError(null);
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [emu]);

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

  // ---- Keyboard → KEYINPUT / EXTKEYIN ----
  // NDS KEYINPUT bits are LOW when pressed. We keep a bitmask of held keys
  // here and apply it to both io9 / io7 on every keydown/keyup. The dance
  // matters: writing to keyinput once at keydown then not at keyup leaves
  // the bit stuck pressed.
  useEffect(() => {
    const KEYINPUT_DEFAULT = 0x03FF;
    const EXTKEY_DEFAULT   = 0x007F;
    let keyinput = KEYINPUT_DEFAULT;
    let extkey   = EXTKEY_DEFAULT;
    const apply = () => {
      emu.io9.keyinput = keyinput;
      emu.io7.keyinput = keyinput;
      emu.io9.extKeyinput = extkey;
      emu.io7.extKeyinput = extkey;
    };
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
      if (m.ext) extkey   &= ~(1 << m.bit);
      else       keyinput &= ~(1 << m.bit);
      apply();
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      const m = bitFor(e.key);
      if (!m) return;
      if (m.ext) extkey   |= (1 << m.bit);
      else       keyinput |= (1 << m.bit);
      apply();
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
        paintCanvas(topCanvasRef.current, emu.ppu.fbA);
        paintCanvas(bottomCanvasRef.current, emu.ppu.fbB);
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
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-zinc-400">Built-in:</span>
          {BUILTIN_ROMS.map((r) => (
            <button
              key={r.path}
              className={`px-2 py-1 rounded text-xs border ${
                src === r.path
                  ? 'bg-emerald-700 border-emerald-500 text-white'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
              }`}
              onClick={() => loadBuiltin(r.path)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-zinc-400 mb-2">…or drag a <code>.nds</code> here.</p>
        <p className="text-xs text-zinc-500">Currently loaded: <code className="text-zinc-300">{src}</code></p>
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
            className="block [image-rendering:pixelated]"
            style={{ width: SCREEN_W * 2, height: SCREEN_H * 2 }}
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
