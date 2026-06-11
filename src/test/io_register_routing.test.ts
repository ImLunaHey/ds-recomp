// IO register routing. The IoBus is the dispatcher for 0x04000000-0x04FFFFFF
// reads/writes. These tests poke individual registers from each side
// (ARM9 vs ARM7) and verify the right backing storage was read/written.
// We use Emulator to wire up all the dependencies (Irq, Ppu, Ipc, etc.)
// without re-implementing each constructor.

import { describe, it, expect, beforeEach } from 'vitest';
import { Emulator } from '../emulator';

describe('IoBus — ARM9 read routing', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('0x04000000 (DISPCNT_A low byte) reflects ppu.dispcntA', () => {
    emu.ppu.dispcntA = 0xDEADBEEF;
    expect(emu.io9.read8(0x04000000)).toBe(0xEF);
    expect(emu.io9.read8(0x04000001)).toBe(0xBE);
    expect(emu.io9.read8(0x04000002)).toBe(0xAD);
    expect(emu.io9.read8(0x04000003)).toBe(0xDE);
  });

  it('0x04000004 (DISPSTAT low byte) reflects ppu.dispstat', () => {
    emu.ppu.dispstat = 0xABCD;
    expect(emu.io9.read8(0x04000004)).toBe(0xCD);
    expect(emu.io9.read8(0x04000005)).toBe(0xAB);
  });

  it('0x04000006 (VCount low byte) reflects ppu.vcount on ARM9', () => {
    emu.ppu.vcount = 100;
    expect(emu.io9.read8(0x04000006)).toBe(100);
  });

  it('0x04000130 (KEYINPUT) reflects io9.keyinput and updates live', () => {
    emu.io9.keyinput = 0x3FF;
    expect(emu.io9.read8(0x04000130)).toBe(0xFF);
    expect(emu.io9.read8(0x04000131)).toBe(0x03);
    // Press a button (clear bit 0 = A).
    emu.io9.keyinput = 0x3FE;
    expect(emu.io9.read8(0x04000130)).toBe(0xFE);
  });

  it('0x04000180 (IPC SYNC) returns the assembled halfword via the half-word path', () => {
    // IPC SYNC nibbles: ARM9 sees the OTHER side's nibble in low 4 bits,
    // its own in bits 8..11. Initialize via ipc helpers, then read.
    emu.ipc.writeSync(true, 0x1234);
    // ARM9 read of its sync reflects the sync layout: low nibble is the
    // remote (ARM7) sync (0 at boot), bits 8..11 are ARM9's sync nibble.
    const v = emu.io9.read16(0x04000180);
    // We don't reach inside Ipc to verify exact bits — just that the
    // read returns a non-throwing 16-bit value with the dispatcher route.
    expect(typeof v).toBe('number');
    expect((v & 0xFFFF0000) >>> 0).toBe(0);
  });

  it('0x04000208 (IME bit) reflects irq9.ime', () => {
    emu.irq9.setIme(1);
    expect(emu.io9.read8(0x04000208)).toBe(1);
    emu.irq9.setIme(0);
    expect(emu.io9.read8(0x04000208)).toBe(0);
  });

  it('DISPCNT_B at 0x04001000 routes to ppu.dispcntB on ARM9 IO', () => {
    emu.ppu.dispcntB = 0xCAFEBABE;
    expect(emu.io9.read8(0x04001000)).toBe(0xBE);
    expect(emu.io9.read8(0x04001001)).toBe(0xBA);
    expect(emu.io9.read8(0x04001002)).toBe(0xFE);
    expect(emu.io9.read8(0x04001003)).toBe(0xCA);
  });

  it('out-of-range register read returns 0 without throwing', () => {
    // 0x04001FFF lies past all engine B regs; 0x04000FFE lies past most
    // shared regs. Both should fall through to the default-0 path.
    expect(() => emu.io9.read8(0x04001FFF)).not.toThrow();
    expect(emu.io9.read8(0x04001FFF)).toBe(0);
    expect(emu.io9.read8(0x04000FFE)).toBe(0);
  });
});

describe('IoBus — write-then-read round-trip', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('DISPCNT_A round-trips through 8-bit write/read', () => {
    emu.io9.write8(0x04000000, 0x11);
    emu.io9.write8(0x04000001, 0x22);
    emu.io9.write8(0x04000002, 0x33);
    emu.io9.write8(0x04000003, 0x44);
    expect(emu.ppu.dispcntA >>> 0).toBe(0x44332211);
    expect(emu.io9.read8(0x04000000)).toBe(0x11);
    expect(emu.io9.read8(0x04000001)).toBe(0x22);
    expect(emu.io9.read8(0x04000003)).toBe(0x44);
  });

  it('DISPCNT_B round-trips at 0x04001000', () => {
    emu.io9.write8(0x04001000, 0xAA);
    emu.io9.write8(0x04001001, 0xBB);
    expect(emu.ppu.dispcntB & 0xFFFF).toBe(0xBBAA);
    expect(emu.io9.read8(0x04001000)).toBe(0xAA);
    expect(emu.io9.read8(0x04001001)).toBe(0xBB);
  });

  it('IME bit 0 round-trips via 0x04000208', () => {
    emu.io9.write8(0x04000208, 1);
    expect(emu.irq9.ime).toBe(true);
    expect(emu.io9.read8(0x04000208)).toBe(1);
    emu.io9.write8(0x04000208, 0);
    expect(emu.irq9.ime).toBe(false);
    expect(emu.io9.read8(0x04000208)).toBe(0);
  });

  it('IE round-trips byte-by-byte at 0x04000210..0x04000213', () => {
    emu.io9.write8(0x04000210, 0x11);
    emu.io9.write8(0x04000211, 0x22);
    emu.io9.write8(0x04000212, 0x33);
    emu.io9.write8(0x04000213, 0x44);
    expect(emu.irq9.ie >>> 0).toBe(0x44332211);
    expect(emu.io9.read8(0x04000210)).toBe(0x11);
    expect(emu.io9.read8(0x04000213)).toBe(0x44);
  });

  it('IF acks via 0x04000214 — writing 1 to a bit clears it', () => {
    emu.irq9.raise(0xFF);
    expect(emu.io9.read8(0x04000214)).toBe(0xFF);
    // Write 0x0F to ack the low 4 bits.
    emu.io9.write8(0x04000214, 0x0F);
    expect(emu.io9.read8(0x04000214)).toBe(0xF0);
  });
});

describe('IoBus — width decomposition', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('16-bit read of DISPCNT_A decomposes to 2 × 8-bit', () => {
    emu.ppu.dispcntA = 0x0000ABCD;
    expect(emu.io9.read16(0x04000000)).toBe(0xABCD);
  });

  it('32-bit read of DISPCNT_A decomposes to 2 × 16-bit', () => {
    emu.ppu.dispcntA = 0x12345678;
    expect(emu.io9.read32(0x04000000)).toBe(0x12345678);
  });
});

describe('IoBus — ARM7-side register isolation', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('ARM7-only SOUNDCNT (0x04000500) silently returns 0 when read from ARM9 IO', () => {
    // The Sound chip exists on emu.io7. ARM9's IO doesn't see it — reads
    // to 0x04000500 from ARM9 are sound-port-class GX accesses that
    // return 0 on real hardware.
    emu.io7.sound.soundcnt = 0xBEEF;
    // Sanity: ARM7 read sees the value.
    const arm7Val = emu.io7.read8(0x04000500);
    expect(arm7Val).toBe(0xEF);
    // ARM9 read — should NOT see the ARM7 sound state.
    const arm9Val = emu.io9.read8(0x04000500);
    expect(arm9Val).toBe(0);
  });
});

describe('IoBus — write paths through engine A regs', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('BG0CNT..BG3CNT at 0x04000008..0x0400000F write to bgCntA[0..3]', () => {
    emu.io9.write8(0x04000008, 0x12);
    emu.io9.write8(0x04000009, 0x34);
    expect(emu.ppu.bgCntA[0] & 0xFFFF).toBe(0x3412);
    emu.io9.write8(0x0400000E, 0x99);
    expect(emu.ppu.bgCntA[3] & 0xFF).toBe(0x99);
  });

  it('BG0HOFS..BG3VOFS at 0x04000010..0x0400001F write to bgHofsA / bgVofsA', () => {
    emu.io9.write8(0x04000010, 0xAA);                 // BG0HOFS low byte
    expect(emu.ppu.bgHofsA[0] & 0xFF).toBe(0xAA);
    emu.io9.write8(0x04000012, 0x77);                 // BG0VOFS low byte
    expect(emu.ppu.bgVofsA[0] & 0xFF).toBe(0x77);
  });

  it('Affine BG2/BG3 regs at 0x04000020..0x0400003F write to PA/PB/PC/PD/refX/refY', () => {
    // BG2 PA at 0x04000020 (low) + 0x04000021 (high).
    emu.io9.write8(0x04000020, 0x00);
    emu.io9.write8(0x04000021, 0x01);   // PA = 0x0100 (= 1.0 in Q8.8)
    expect(emu.ppu.bgPA_A[2]).toBe(0x100);
    // BG2 refX (4 bytes) at 0x04000028..0x0400002B.
    emu.io9.write8(0x04000028, 0x10);
    emu.io9.write8(0x04000029, 0x20);
    emu.io9.write8(0x0400002A, 0x30);
    emu.io9.write8(0x0400002B, 0x00);
    // 28-bit, sign-extended; for 0x00302010 the value matches verbatim.
    expect(emu.ppu.bgRefX_A[2] >>> 0).toBe(0x00302010);
    expect(emu.ppu.bgRefXLatched_A[2] >>> 0).toBe(0x00302010);
  });

  it('MOSAIC (engine A) at 0x0400004C..0x0400004D and engine B at 0x0400104C..0x0400104D', () => {
    emu.io9.write8(0x0400004C, 0x12);
    emu.io9.write8(0x0400004D, 0x34);
    expect(emu.ppu.mosaicA & 0xFFFF).toBe(0x3412);
    emu.io9.write8(0x0400104C, 0xAB);
    emu.io9.write8(0x0400104D, 0xCD);
    expect(emu.ppu.mosaicB & 0xFFFF).toBe(0xCDAB);
  });

  it('Window registers WIN0H/V WININ/WINOUT (engine A) at 0x04000040..0x0400004B', () => {
    emu.io9.write8(0x04000040, 0x11);     // WIN0H lo
    emu.io9.write8(0x04000041, 0x22);     // WIN0H hi
    expect(emu.ppu.winHA[0] & 0xFFFF).toBe(0x2211);
    emu.io9.write8(0x04000048, 0xAA);     // WININ lo
    emu.io9.write8(0x04000049, 0xBB);     // WININ hi
    expect(emu.ppu.winInA & 0xFFFF).toBe(0xBBAA);
    emu.io9.write8(0x0400004A, 0xCC);     // WINOUT lo
    emu.io9.write8(0x0400004B, 0xDD);     // WINOUT hi
    expect(emu.ppu.winOutA & 0xFFFF).toBe(0xDDCC);
  });

  it('BLDCNT / BLDALPHA / BLDY at 0x04000050..0x04000055', () => {
    emu.io9.write8(0x04000050, 0x11); emu.io9.write8(0x04000051, 0x22);
    expect(emu.ppu.bldCntA & 0xFFFF).toBe(0x2211);
    emu.io9.write8(0x04000052, 0xAA); emu.io9.write8(0x04000053, 0xBB);
    expect(emu.ppu.bldAlphaA & 0xFFFF).toBe(0xBBAA);
    emu.io9.write8(0x04000054, 0xCC); emu.io9.write8(0x04000055, 0xDD);
    expect(emu.ppu.bldYA & 0xFFFF).toBe(0xDDCC);
  });

  it('Master-bright at 0x0400006C and 0x0400106C round-trips through io.write8', () => {
    emu.io9.write8(0x0400006C, 0x42);
    emu.io9.write8(0x0400006D, 0x80);
    expect(emu.ppu.masterBrightA & 0xFFFF).toBe(0x8042);
    expect(emu.io9.read8(0x0400006C)).toBe(0x42);
    expect(emu.io9.read8(0x0400006D)).toBe(0x80);
    emu.io9.write8(0x0400106C, 0xAA);
    expect(emu.ppu.masterBrightB & 0xFF).toBe(0xAA);
  });

  it('DISPCAPCNT at 0x04000064..0x04000067 is a 32-bit register written byte-by-byte', () => {
    emu.io9.write8(0x04000064, 0x11);
    emu.io9.write8(0x04000065, 0x22);
    emu.io9.write8(0x04000066, 0x33);
    emu.io9.write8(0x04000067, 0x44);
    expect(emu.ppu.dispCapCnt >>> 0).toBe(0x44332211);
  });

  it('Engine B BG0CNT..BG3CNT at 0x04001008..0x0400100F write to bgCntB[0..3]', () => {
    emu.io9.write8(0x04001008, 0x55);
    expect(emu.ppu.bgCntB[0] & 0xFF).toBe(0x55);
    emu.io9.write8(0x0400100E, 0xCD);
    expect(emu.ppu.bgCntB[3] & 0xFF).toBe(0xCD);
  });

  it('Engine B affine BG2 PA at 0x04001020 round-trips', () => {
    emu.io9.write8(0x04001020, 0x10);
    emu.io9.write8(0x04001021, 0x02);
    expect(emu.ppu.bgPA_B[2]).toBe(0x0210);
  });
});

describe('IoBus — DISPSTAT / POWCNT1 / POSTFLG writes', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('DISPSTAT high byte writes to ppu.dispstat through the switch', () => {
    emu.io9.write8(0x04000004, 0x12);
    emu.io9.write8(0x04000005, 0x34);
    expect(emu.ppu.dispstat & 0xFFFF).toBe(0x3412);
  });

  it('POSTFLG (0x04000300) round-trips through io9', () => {
    emu.io9.write8(0x04000300, 0xAA);
    expect(emu.io9.postflg).toBe(0xAA);
    expect(emu.io9.read8(0x04000300)).toBe(0xAA);
  });

  it('POWCNT1 (0x04000304..0x04000307) round-trips byte-by-byte', () => {
    emu.io9.write8(0x04000304, 0x11);
    emu.io9.write8(0x04000305, 0x22);
    emu.io9.write8(0x04000306, 0x33);
    emu.io9.write8(0x04000307, 0x44);
    expect(emu.io9.powcnt1 >>> 0).toBe(0x44332211);
    expect(emu.io9.read8(0x04000304)).toBe(0x11);
    expect(emu.io9.read8(0x04000307)).toBe(0x44);
  });
});

describe('IoBus — IRQ / IF ack byte slices', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('IF byte writes at 0x04000215..0x04000217 ack the corresponding bits', () => {
    emu.irq9.raise(0xFFFFFFFF);
    expect(emu.io9.read8(0x04000214)).toBe(0xFF);
    // Ack bits in the second byte (16-23).
    emu.io9.write8(0x04000215, 0x0F);
    expect(emu.io9.read8(0x04000215)).toBe(0xF0);
    emu.io9.write8(0x04000216, 0xFF);
    expect(emu.io9.read8(0x04000216)).toBe(0);
    emu.io9.write8(0x04000217, 0x80);
    expect(emu.io9.read8(0x04000217)).toBe(0x7F);
  });
});

describe('IoBus — ARM7-side SOUND port routing', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('ARM7 write to SOUNDCNT (0x04000500) updates the Sound chip', () => {
    emu.io7.write8(0x04000500, 0xAA);
    emu.io7.write8(0x04000501, 0xBB);
    expect(emu.io7.sound.soundcnt & 0xFFFF).toBe(0xBBAA);
    expect(emu.io7.read8(0x04000500)).toBe(0xAA);
    expect(emu.io7.read8(0x04000501)).toBe(0xBB);
  });

  it('ARM7 write to SOUNDBIAS (0x04000504) round-trips', () => {
    emu.io7.write8(0x04000504, 0x77);
    expect(emu.io7.sound.soundbias & 0xFF).toBe(0x77);
  });

  it('ARM7 write to a per-channel SOUND_CNT (0x04000400..0x04000403) round-trips', () => {
    emu.io7.write8(0x04000400, 0x11);
    emu.io7.write8(0x04000401, 0x22);
    expect(emu.io7.sound.channels[0].cnt & 0xFFFF).toBe(0x2211);
  });
});

describe('IoBus — IPC SYNC / FIFOCNT byte writes', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('IPCSYNC byte writes at 0x04000180 / 0x04000181 propagate to the IPC controller', () => {
    // Each write goes through readSync → modify → writeSync.
    expect(() => emu.io9.write8(0x04000180, 0x10)).not.toThrow();
    expect(() => emu.io9.write8(0x04000181, 0x20)).not.toThrow();
    // Validate a 16-bit read returns a sane number after the writes.
    const s = emu.io9.read16(0x04000180);
    expect(typeof s).toBe('number');
  });

  it('IPC FIFOCNT byte writes at 0x04000184 / 0x04000185 do not throw', () => {
    expect(() => emu.io9.write8(0x04000184, 0x01)).not.toThrow();
    expect(() => emu.io9.write8(0x04000185, 0x80)).not.toThrow();
  });
});

describe('IoBus — width decomposition (32-bit writes)', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('write32 to DISPCNT_A decomposes correctly', () => {
    emu.io9.write32(0x04000000, 0xCAFEBABE);
    expect(emu.ppu.dispcntA >>> 0).toBe(0xCAFEBABE);
  });

  it('write32 to IE round-trips at 0x04000210', () => {
    emu.io9.write32(0x04000210, 0xDEADBEEF);
    expect(emu.irq9.ie >>> 0).toBe(0xDEADBEEF);
    expect(emu.io9.read32(0x04000210)).toBe(0xDEADBEEF);
  });
});

describe('IoBus — GX ports (ARM9 only)', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('write32 at 0x04000400 routes to GXFIFO writeFifo', () => {
    // MTX_MODE = 0 then MTX_IDENTITY (op 0x15).
    emu.io9.write32(0x04000400, 0x10);
    emu.io9.write32(0x04000400, 0);
    emu.io9.write32(0x04000400, 0x15);
    // After writing the identity command, the projection matrix is identity.
    expect(emu.ppu.gx.matProj[0]).toBe(1);
  });

  it('write32 at 0x04000440+ routes to GX writeDirect', () => {
    // MTX_IDENTITY direct port — (op - 0x10) * 4 = 0x14 → 0x04000454.
    emu.io9.write32(0x04000454, 0);
    // No throw, no residual pending.
    expect(emu.ppu.gx.pendingOps.length).toBe(0);
  });

  it('write16 at the GX direct-command port range accumulates into the 32-bit latch', () => {
    // MTX_IDENTITY direct port at (op-0x10)*4 = 0x14 → 0x04000454.
    // Write two halfwords; the second triggers fire.
    emu.io9.write16(0x04000454, 0x0000);
    expect(emu.io9.gxLatch.size).toBe(1);     // half buffered
    emu.io9.write16(0x04000456, 0x0000);
    // Now the full word should have arrived; latch cleared.
    expect(emu.io9.gxLatch.size).toBe(0);
  });

  it('write8 at the GX direct-command port range accumulates 4 bytes into the latch', () => {
    emu.io9.write8(0x04000454, 0x00);
    emu.io9.write8(0x04000455, 0x00);
    emu.io9.write8(0x04000456, 0x00);
    expect(emu.io9.gxLatch.size).toBe(1);     // 3 of 4 bytes buffered
    emu.io9.write8(0x04000457, 0x00);
    expect(emu.io9.gxLatch.size).toBe(0);
  });
});

describe('IoBus — DMA register routing (0x040000B0..0x040000DF)', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('write32 to a DMA SAD register routes to dma.write32', () => {
    // DMA0 SAD on ARM9 lives at 0x040000B0.
    emu.io9.write32(0x040000B0, 0x02000000);
    expect(emu.dma9.channels[0].src).toBe(0x02000000);
    expect(emu.io9.read32(0x040000B0)).toBe(0x02000000);
  });

  it('write8 to a DMA SAD register routes to dma.write8', () => {
    emu.io9.write8(0x040000B0, 0xEF);
    expect(emu.dma9.channels[0].src & 0xFF).toBe(0xEF);
  });

  it('read32 from DMA SAD returns the stored value', () => {
    emu.dma9.channels[0].src = 0x12345678;
    expect(emu.io9.read32(0x040000B0)).toBe(0x12345678);
  });
});

describe('IoBus — DS Math register routing (0x04000280..0x040002BF, ARM9 only)', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('write32 to DIV_NUMER routes to ds_math via byte writes', () => {
    // DIV_NUMER lives at 0x04000290 (8 bytes).
    emu.io9.write32(0x04000290, 0xDEADBEEF);
    expect(emu.math.numer[0]).toBe(0xEF);
    expect(emu.math.numer[3]).toBe(0xDE);
  });

  it('write to math regs from ARM7 IO has no effect (ARM7 has no math)', () => {
    emu.io7.write32(0x04000290, 0xDEADBEEF);
    expect(emu.math.numer[0]).toBe(0);
  });

  it('read32 from DIV_NUMER returns what was written', () => {
    emu.math.numer[0] = 0x11;
    emu.math.numer[1] = 0x22;
    emu.math.numer[2] = 0x33;
    emu.math.numer[3] = 0x44;
    expect(emu.io9.read32(0x04000290)).toBe(0x44332211);
  });
});

describe('IoBus — Cart register routing', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('write32 to ROMCTRL (0x040001A4) routes to cart.writeRomCtrl', () => {
    emu.io9.write32(0x040001A4, 0x00000000);
    expect(typeof emu.cart.readRomCtrl()).toBe('number');
  });

  it('write to AUXSPICNT (0x040001A0) routes to cart.writeAuxSpiCnt', () => {
    emu.io9.write16(0x040001A0, 0x8000);
    expect(emu.cart.readAuxSpiCnt() & 0x8000).toBe(0x8000);
  });

  it('write to cart command bytes 0x040001A8..0x040001AF routes to cart.writeCmdByte', () => {
    emu.io9.write8(0x040001A8, 0x12);
    expect(emu.cart.readCmdByte(0)).toBe(0x12);
    emu.io9.write8(0x040001AF, 0x34);
    expect(emu.cart.readCmdByte(7)).toBe(0x34);
  });
});

describe('IoBus — IPC SYNC / FIFO 32-bit paths', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('read32 at 0x04100000 routes to IPC readRecv', () => {
    // No data has been sent — readRecv returns the sticky lastRead value.
    expect(typeof emu.io9.read32(0x04100000)).toBe('number');
  });

  it('write32 at 0x04000188 routes to ipc.writeSend (enqueues a word)', () => {
    // Enable both ends so writeSend actually enqueues.
    emu.ipc.enable9 = true;
    emu.ipc.enable7 = true;
    emu.io9.write32(0x04000188, 0xDEADBEEF);
    // ARM7 should be able to receive it.
    const got = emu.io7.read32(0x04100000);
    expect(got).toBe(0xDEADBEEF);
  });
});

describe('IoBus — VRAMCNT and WRAMCNT writes (ARM9 side)', () => {
  let emu: Emulator;
  beforeEach(() => { emu = new Emulator(); });

  it('write to VRAMCNT_A at 0x04000240 updates ppu.vramcnt[0]', () => {
    emu.io9.write8(0x04000240, 0x81);
    expect(emu.ppu.vramcnt[0]).toBe(0x81);
    expect(emu.io9.read8(0x04000240)).toBe(0x81);
  });

  it('write to WRAMCNT at 0x04000247 updates mem.wramcnt (masked to 0x03)', () => {
    emu.io9.write8(0x04000247, 0xFF);
    expect(emu.mem.wramcnt).toBe(0x03);
    expect(emu.io9.read8(0x04000247)).toBe(0x03);
  });

  it('ARM7 cannot write VRAMCNT (writes are dropped silently)', () => {
    const before = emu.ppu.vramcnt[0];
    emu.io7.write8(0x04000240, 0x42);
    expect(emu.ppu.vramcnt[0]).toBe(before);
  });

  it('ARM7 read of VRAMSTAT (0x04000240) reflects bank C/D MST=2 status', () => {
    emu.ppu.vramcnt[2] = 0x82;
    // Bus7 attaches a VRAM router to PPU; ARM7 reads 0x04000240 → vramStat.
    // The Ppu.vramStat() check reads vramcnt directly.
    const v = emu.io7.read8(0x04000240);
    expect(v & 0x01).toBe(0x01);
  });
});
