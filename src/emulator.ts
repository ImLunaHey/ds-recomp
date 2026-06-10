// Top-level DS emulator. Owns the two memory buses, the two CPUs, two
// IRQ controllers, one PPU, and an IO router per CPU. runFrame()
// advances both cores in lockstep batches and ticks the PPU once per
// batch so VBlank lands at roughly the right boundary.

import { SharedMemory } from './memory/shared';
import { Bus9 } from './memory/bus9';
import { Bus7 } from './memory/bus7';
import { VramRouter, setActiveVramRouter } from './memory/vram_router';
import { loadNdsRom, type LoadResult } from './cart/loader';
import { parseNdsHeader, type NdsHeader } from './cart/header';
import { Cart } from './cart/cart';
import { loadAllOverlays, type OverlayLoadStats } from './cart/overlays';
import { tryHandleNsmbFsThunk, NSMB_FS_THUNK_ADDR } from './cart/nsmb_fs_assist';
import { Cpu } from './cpu/cpu';
import { Cp15 } from './cpu/cp15';
import { Irq } from './io/irq';
import { IoBus } from './io/io';
import { Ipc } from './io/ipc';
import { Dma } from './io/dma';
import { DsMath } from './io/ds_math';
import { Spi } from './io/spi';
import { Timers } from './io/timers';
import { Wifi } from './io/wifi';
import { Ppu, DOTS_PER_LINE, LINES_PER_FRAME } from './ppu/ppu';
import { BiosHle } from './bios/hle';
import { installBiosStubs } from './bios/stub';

const DOT_CYCLES_PER_FRAME = DOTS_PER_LINE * LINES_PER_FRAME;
const ARM9_STEPS_PER_DOT = 2;
const ARM7_STEPS_PER_DOT = 1;

export class Emulator {
  mem = new SharedMemory();
  bus9: Bus9;
  bus7: Bus7;
  irq9 = new Irq();
  irq7 = new Irq();
  ppu: Ppu;
  ipc: Ipc;
  cart: Cart;
  dma9: Dma;
  dma7: Dma;
  math = new DsMath();      // ARM9 only — ARM7 sees these registers as 0
  spi = new Spi();          // ARM7 only — ARM9 sees SPI registers as 0
  wifi = new Wifi();        // ARM7 only — WiFi MMIO at 0x04800000-0x04807FFF
  timers9: Timers;          // 4 timers per CPU
  timers7: Timers;
  io9: IoBus;
  io7: IoBus;
  cpu9: Cpu;
  cpu7: Cpu;
  bios9: BiosHle;
  bios7: BiosHle;
  header: NdsHeader | null = null;
  load: LoadResult | null = null;
  overlays: OverlayLoadStats | null = null;
  totalDots = 0;

  constructor() {
    this.bus9 = new Bus9(this.mem);
    this.bus7 = new Bus7(this.mem);
    this.ppu = new Ppu(this.mem, this.irq9, this.irq7);
    const vramRouter = new VramRouter(this.ppu.vramcnt);
    this.bus9.vram = vramRouter;
    this.bus7.vram = vramRouter;
    // Make the router visible to the PPU scanline renderers, which can't
    // receive it through their (frozen) function signatures.
    setActiveVramRouter(vramRouter);
    this.ipc = new Ipc(this.irq9, this.irq7);
    this.cart = new Cart();
    this.dma9 = new Dma(this.bus9, this.irq9, true);
    this.dma7 = new Dma(this.bus7, this.irq7, false);
    this.timers9 = new Timers(this.irq9);
    this.timers7 = new Timers(this.irq7);
    this.ppu.dma9 = this.dma9;
    this.ppu.dma7 = this.dma7;
    this.ppu.ipc = this.ipc;
    this.io9 = new IoBus(this.irq9, this.ppu, this.mem, this.ipc, this.cart, this.dma9, this.math, null,     true);
    this.io7 = new IoBus(this.irq7, this.ppu, this.mem, this.ipc, this.cart, this.dma7, null,      this.spi, false);
    this.io9.timers = this.timers9;
    this.io7.timers = this.timers7;
    this.bus9.attachIo(this.io9);
    this.bus7.attachIo(this.io7);
    this.bus7.attachWifi(this.wifi);
    this.cpu9 = new Cpu(this.bus9, true);
    this.cpu7 = new Cpu(this.bus7, false);
    // BIOS stub bytes first — Cp15's constructor patches the IRQ handler
    // ptr literal inside them based on the current DTCM placement.
    installBiosStubs(this.mem);
    this.cpu9.cp15 = new Cp15(this.bus9, this.mem);
    this.cpu9.cp15.cpu = this.cpu9;
    this.bios9 = new BiosHle(this.cpu9, this.irq9);
    this.bios7 = new BiosHle(this.cpu7, this.irq7);
    this.cpu9.bios = this.bios9;
    this.cpu7.bios = this.bios7;
    this.io9.bios = this.bios9;
    this.io7.bios = this.bios7;
  }

  loadRom(rom: Uint8Array): void {
    this.header = parseNdsHeader(rom);
    this.load = loadNdsRom(rom, this.header, this.bus9, this.bus7, this.mem);
    this.overlays = loadAllOverlays(rom, this.header, this.bus9, this.bus7, this.mem);
    this.cart.loadRom(rom);
    // Per GBATEK § "BIOS RAM Usage": firmware copies the user settings
    // block from firmware[0x3FE00] to main RAM at 0x027FFC80. The
    // loader can't do this because the firmware blob lives on Spi;
    // patch it here after spi has been constructed.
    const MAIN_RAM_MASK = 0x003FFFFF;
    const fwUserStart = 0x3FE00;
    const ramUserStart = 0x027FFC80 & MAIN_RAM_MASK;
    for (let i = 0; i < 0x70; i++) {
      this.mem.mainRam[ramUserStart + i] = this.spi.firmware[fwUserStart + i] ?? 0;
    }
    this.resetCpus();
  }

  private resetCpus(): void {
    const h = this.header!;
    this.cpu9.reset(h.arm9EntryAddr, 0x0380FF00, 0x0380FFA0, 0x0380FFE0);
    this.cpu7.reset(h.arm7EntryAddr, 0x0380FF00, 0x0380FFA0, 0x0380FFE0);
    this.ppu.dispcntA = 0;
    this.ppu.dispcntB = 0;
    this.ppu.vcount = 0;
    this.ppu.cyclesAccum = 0;
    this.ppu.dispstat = 0;
    this.totalDots = 0;
  }

  runFrame(): { arm9: number; arm7: number; frame: number } {
    const ppu = this.ppu;
    const cpu9 = this.cpu9;
    const cpu7 = this.cpu7;
    const irq9 = this.irq9;
    const irq7 = this.irq7;
    // Finer-grained interleave: one ARM9 step, then conditionally one
    // ARM7 step (because the dot clock ratio is 2:1). The IPC handshake
    // is sensitive to who runs first — a coarse "all ARM9 then all
    // ARM7 per batch" left both sides talking past each other.
    const BATCH = 16;
    let dotsThisFrame = 0;
    let arm9Steps = 0;
    let arm7Steps = 0;
    let a7Carry = 0;

    while (dotsThisFrame < DOT_CYCLES_PER_FRAME) {
      const batch = Math.min(BATCH, DOT_CYCLES_PER_FRAME - dotsThisFrame);
      const a9Budget = batch * ARM9_STEPS_PER_DOT;
      // Each ARM9 step gets paired with 0 or 1 ARM7 step at a 2:1 ratio.
      for (let i = 0; i < a9Budget; i++) {
        cpu9.irqLine = irq9.cachedPending;
        cpu9.wakeLine = irq9.wakePending;
        // Halted CPU with no wake-line still needs to consume a "tick"
        // worth of step() so the halt-wake check inside step() actually
        // runs — otherwise stepping is skipped and the CPU never re-
        // evaluates wake. We let step() handle the halt-wake itself.
        if (!(cpu9.state.halted && !cpu9.wakeLine)) {
          // NSMB NitroFS assist. The PPU's VBlank hook (applyNsmbFsThunk)
          // patches every FS handle's +0x50 vtable slot to point at our
          // shared "MOV R0,#6 ; BX LR" thunk at 0x023FF800 — but the SDK
          // dispatcher's callback isn't just supposed to return 6, it's
          // supposed to copy the requested bytes from cart ROM to the dst
          // buffer in main RAM. The inline ARM bytes can't do that (cart
          // ROM isn't memory-mapped on ARM9). So BEFORE letting the CPU
          // execute the next instruction at the thunk address, we copy
          // the bytes in JS and BX-LR back ourselves. The inline ARM
          // body (still parked in main RAM) is the synchronous
          // fallback — exercised by direct-Cpu.step tests and as a
          // backstop if the assist ever no-ops a call.
          if ((cpu9.state.r[15] & ~3) === NSMB_FS_THUNK_ADDR) {
            tryHandleNsmbFsThunk(cpu9, {
              rom: this.cart.rom,
              mainRam: this.mem.mainRam,
            });
          }
          cpu9.step();
          arm9Steps++;
        }
        a7Carry += ARM7_STEPS_PER_DOT;
        if (a7Carry >= ARM9_STEPS_PER_DOT) {
          a7Carry -= ARM9_STEPS_PER_DOT;
          cpu7.irqLine = irq7.cachedPending;
          cpu7.wakeLine = irq7.wakePending;
          if (!(cpu7.state.halted && !cpu7.wakeLine)) {
            cpu7.step();
            arm7Steps++;
          }
        }
      }
      ppu.step(batch);
      // Step timers per batch (dots ≈ ARM cycles in our 1:1 model).
      // ARM7 uses the same dot budget — its prescalers divide further.
      this.timers9.step(batch * 2);   // ARM9 runs 2× per dot in our model
      this.timers7.step(batch);
      // Sound chip is on ARM7's side; step it with ARM7 cycle budget so
      // channels with key-on eventually clear when their sample length
      // elapses (games poll the key-on bit to know when to start the
      // next sample).
      this.io7.sound.step(batch);
      dotsThisFrame += batch;
      if (ppu.frameDone) { ppu.frameDone = false; break; }
    }
    this.totalDots += dotsThisFrame;
    return { arm9: arm9Steps, arm7: arm7Steps, frame: ppu.frameCount };
  }

  readBlock9(addr: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.bus9.read8(addr + i);
    return out;
  }
  readBlock7(addr: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.bus7.read8(addr + i);
    return out;
  }
}
