// Shared bus interface for both ARM cores. Bus9 and Bus7 both
// implement this — passing it explicitly keeps the CPU class
// agnostic to which side it's running on.

export interface ArmBus {
  read8(addr: number): number;
  read16(addr: number): number;
  read32(addr: number): number;
  write8(addr: number, v: number): void;
  write16(addr: number, v: number): void;
  write32(addr: number, v: number): void;
}
