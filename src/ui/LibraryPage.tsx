// ROM library — grid of cards grouped by status tier (visible / partial
// / stalls / tests). Each card links to the per-ROM detail page where
// the user can read known issues and choose to actually load the ROM
// into the player.

import { Link } from 'react-router-dom';
import { ROM_LIBRARY, type RomMeta, romSlug } from './romMeta';

const TIER_LABEL: Record<string, string> = {
  '🟢': 'Visible content',
  '🟡': 'Boots, partial render',
  '🔴': 'Stalls early',
  '🧪': 'Tests / homebrew',
};

const TIER_ORDER = ['🟢', '🟡', '🔴', '🧪'] as const;

const TIER_BORDER: Record<string, string> = {
  '🟢': 'border-emerald-700/60 hover:border-emerald-500',
  '🟡': 'border-amber-700/60 hover:border-amber-500',
  '🔴': 'border-zinc-700 hover:border-zinc-500',
  '🧪': 'border-sky-700/60 hover:border-sky-500',
};

function RomCard({ rom }: { rom: RomMeta }) {
  return (
    <Link
      to={`/rom/${romSlug(rom.path)}`}
      className={`block p-3 rounded-lg border bg-zinc-900 transition-colors ${TIER_BORDER[rom.tier]}`}
    >
      <div className="flex items-start gap-2">
        <span className="text-2xl leading-none" aria-hidden="true">{rom.tier}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-zinc-100 truncate">{rom.label}</div>
          {rom.blurb && (
            <div className="text-[11px] text-zinc-400 mt-0.5 line-clamp-2">{rom.blurb}</div>
          )}
          {rom.issues.length > 0 && (
            <div className="text-[10px] text-zinc-500 mt-1">
              {rom.issues.length} known issue{rom.issues.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

export function LibraryPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">ds-recomp library</h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            NDS emulator + JIT recompiler. Click a ROM for known issues + the play button.
          </p>
        </div>
        <div className="text-xs text-zinc-500">
          {ROM_LIBRARY.length} ROMs ·{' '}
          {ROM_LIBRARY.filter((r) => r.tier === '🟢').length} visible ·{' '}
          {ROM_LIBRARY.filter((r) => r.tier === '🟡').length} partial ·{' '}
          {ROM_LIBRARY.filter((r) => r.tier === '🔴').length} stalls
        </div>
      </header>

      <main className="px-6 py-6 space-y-8 max-w-7xl mx-auto">
        {TIER_ORDER.map((tier) => {
          const roms = ROM_LIBRARY.filter((r) => r.tier === tier);
          if (roms.length === 0) return null;
          return (
            <section key={tier}>
              <h2 className="text-sm font-semibold text-zinc-300 mb-3">
                <span className="mr-1.5">{tier}</span>
                {TIER_LABEL[tier]}
                <span className="text-zinc-500 font-normal ml-2">({roms.length})</span>
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
                {roms.map((rom) => (
                  <RomCard key={rom.path} rom={rom} />
                ))}
              </div>
            </section>
          );
        })}

        <footer className="text-[11px] text-zinc-500 pt-8 border-t border-zinc-800 mt-8">
          <p>
            Status is best-effort — measured by running each ROM for 1800 frames (30 sec game time)
            and sampling distinct framebuffer colors at 5 timestamps. "Boots, partial render" means
            display registers are configured + VRAM populated but composition produces ≤ 10 colors.
          </p>
        </footer>
      </main>
    </div>
  );
}
