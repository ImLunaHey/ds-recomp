// Shared Emulator instance for the router pages. Created once at the
// App root and survives navigation between LibraryPage, RomDetailPage,
// and PlayerPage — switching ROMs doesn't tear down the audio context
// or rebuild bus wiring; the emulator's own reset() inside loadRom is
// what handles per-ROM cleanup.

import { createContext, useContext } from 'react';
import { Emulator } from '../emulator';

interface EmuCtx {
  emu: Emulator;
}

export const EmuContext = createContext<EmuCtx | null>(null);

export function useEmu(): Emulator {
  const ctx = useContext(EmuContext);
  if (!ctx) throw new Error('useEmu must be called inside <EmuContext.Provider>');
  return ctx.emu;
}
