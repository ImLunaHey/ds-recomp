// Per-ROM detail page — surfaces the ROM's known issues + a Play button
// that navigates into the player. Reads the ROM identity from the
// `:slug` URL param.

import { Link, useParams, useNavigate } from 'react-router-dom';
import { getRomMeta, pathFromSlug, romSlug, ROM_LIBRARY } from './romMeta';

const TIER_LABEL: Record<string, string> = {
  '🟢': 'Visible content rendering',
  '🟡': 'Boots past SDK init, partial render',
  '🔴': 'Stalls early',
  '🧪': 'Test / homebrew',
};

const TIER_PILL: Record<string, string> = {
  '🟢': 'bg-emerald-900/40 text-emerald-300 border-emerald-700',
  '🟡': 'bg-amber-900/40 text-amber-300 border-amber-700',
  '🔴': 'bg-zinc-800 text-zinc-300 border-zinc-600',
  '🧪': 'bg-sky-900/40 text-sky-300 border-sky-700',
};

export function RomDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const path = pathFromSlug(slug);
  const rom = getRomMeta(path);

  // If somehow we end up on an unknown slug, fall back gracefully.
  if (!rom) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-6">
        <Link to="/" className="text-xs text-zinc-400 hover:text-zinc-200">← Library</Link>
        <h1 className="text-xl font-bold mt-4">Unknown ROM</h1>
        <p className="text-sm text-zinc-400 mt-2">
          We don't have metadata for <code className="text-zinc-300">{path}</code> in the library
          registry. You can still load it from the player page.
        </p>
        <button
          type="button"
          onClick={() => navigate(`/play/${slug}`)}
          className="mt-4 px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-semibold"
        >
          ▶ Play anyway
        </button>
      </div>
    );
  }

  // Find prev/next in the library for navigation arrows.
  const idx = ROM_LIBRARY.findIndex((r) => r.path === rom.path);
  const prev = idx > 0 ? ROM_LIBRARY[idx - 1] : null;
  const next = idx >= 0 && idx < ROM_LIBRARY.length - 1 ? ROM_LIBRARY[idx + 1] : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
        <Link to="/" className="text-xs text-zinc-400 hover:text-zinc-200">← Library</Link>
        <div className="flex gap-3 text-xs text-zinc-500">
          {prev && (
            <Link to={`/rom/${romSlug(prev.path)}`} className="hover:text-zinc-200">
              ← {prev.label}
            </Link>
          )}
          {next && (
            <Link to={`/rom/${romSlug(next.path)}`} className="hover:text-zinc-200">
              {next.label} →
            </Link>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <div>
          <div className="flex items-center gap-3">
            <span className="text-4xl leading-none">{rom.tier}</span>
            <div>
              <h1 className="text-2xl font-bold">{rom.label}</h1>
              <div className="flex items-center gap-2 mt-1 text-[11px]">
                <span className={`inline-block px-2 py-0.5 rounded border ${TIER_PILL[rom.tier]}`}>
                  {TIER_LABEL[rom.tier]}
                </span>
                <span className="text-zinc-500">{rom.kind === 'retail' ? 'Retail' : 'Test ROM'}</span>
              </div>
            </div>
          </div>
          {rom.blurb && <p className="text-sm text-zinc-300 mt-4">{rom.blurb}</p>}
          <p className="text-[11px] text-zinc-500 mt-3 font-mono">{rom.path}</p>
        </div>

        <button
          type="button"
          onClick={() => navigate(`/play/${slug}`)}
          className="block w-full sm:w-auto px-6 py-3 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-base shadow"
        >
          ▶ Play
        </button>

        <section>
          <h2 className="text-sm font-semibold text-zinc-200 mb-2">Known issues</h2>
          {rom.issues.length === 0 ? (
            <p className="text-sm text-zinc-500 italic">No notable issues recorded.</p>
          ) : (
            <ul className="space-y-2">
              {rom.issues.map((issue, i) => (
                <li
                  key={i}
                  className="text-sm text-zinc-300 pl-3 border-l-2 border-zinc-700 py-0.5"
                >
                  {issue}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
