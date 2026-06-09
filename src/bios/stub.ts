// Installs a tiny IRQ-dispatch stub in each CPU's BIOS region. Real DS
// BIOS does much more (auth, decompression entry points, SWI table),
// but for boot it's enough that the IRQ vector at 0x18 saves context,
// jumps to the user-stored handler ptr, and returns with CPSR restored.
//
// User IRQ handler conventions:
//   ARM7: stored at 0x03FFFFFC (mirror of 0x0380FFFC, end of IWRAM).
//         Reachable from a fixed [R0=#0x04000000, #-4] address.
//   ARM9: stored at 0x027FFFFC (top of main RAM). Out of range for the
//         12-bit LDR immediate, so we put the address in a literal.

import type { SharedMemory } from '../memory/shared';

function wr32(bios: Uint8Array, off: number, v: number): void {
  bios[off + 0] =  v        & 0xFF;
  bios[off + 1] = (v >>  8) & 0xFF;
  bios[off + 2] = (v >> 16) & 0xFF;
  bios[off + 3] = (v >> 24) & 0xFF;
}

export function installBiosStubs(mem: SharedMemory): void {
  installArm7(mem.biosArm7);
  installArm9(mem.biosArm9);
}

function installArm7(bios: Uint8Array): void {
  // Loop-on-self at all standard vectors except IRQ.
  for (let v = 0x00; v < 0x18; v += 4) wr32(bios, v, 0xEAFFFFFE);
  // IRQ vector at 0x18 — branch to the dispatcher right after it.
  wr32(bios, 0x18, 0xE92D500F);  // STMFD SP!, {R0-R3, R12, LR}
  wr32(bios, 0x1C, 0xE3A00301);  // MOV R0, #0x4000000
  wr32(bios, 0x20, 0xE28FE000);  // ADR LR, returnLabel (next next = 0x28)
  wr32(bios, 0x24, 0xE510F004);  // LDR PC, [R0, #-4] — = [0x03FFFFFC]
  wr32(bios, 0x28, 0xE8BD500F);  // returnLabel: LDMFD SP!, {R0-R3, R12, LR}
  wr32(bios, 0x2C, 0xE25EF004);  // SUBS PC, LR, #4 (returns + restores CPSR)
  // FIQ vector: loop.
  wr32(bios, 0x1C, 0xE3A00301);
}

function installArm9(bios: Uint8Array): void {
  for (let v = 0x00; v < 0x18; v += 4) wr32(bios, v, 0xEAFFFFFE);
  wr32(bios, 0x18, 0xE92D500F);  // STMFD SP!, {R0-R3, R12, LR}                            ; 0x18
  wr32(bios, 0x1C, 0xE59F0010);  // LDR R0, [PC, #0x10]  — reads from 0x34 (literal)       ; 0x1C
  wr32(bios, 0x20, 0xE5900000);  // LDR R0, [R0]                                           ; 0x20
  wr32(bios, 0x24, 0xE28FE000);  // ADR LR, returnLabel (PC+8 = 0x2C)                      ; 0x24
  wr32(bios, 0x28, 0xE12FFF10);  // BX R0                                                  ; 0x28
  wr32(bios, 0x2C, 0xE8BD500F);  // returnLabel: LDMFD SP!, {R0-R3, R12, LR}               ; 0x2C
  wr32(bios, 0x30, 0xE25EF004);  // SUBS PC, LR, #4                                        ; 0x30
  wr32(bios, 0x34, 0x027FFFFC);  // literal: user handler pointer location                 ; 0x34
}
