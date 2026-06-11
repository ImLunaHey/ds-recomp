// Per-ROM metadata for the library / detail pages. Each entry knows:
// - the relative path the ROM is fetched from (public/<name>.nds)
// - a short display label
// - a status tier — 🟢 visible content / 🟡 boots, no display / 🔴 stalls
// - a list of known issues + caveats the player should expect
//
// `issues` strings are surfaced verbatim on the detail page. Keep them
// short and concrete; if a fix lands, edit the matching entry instead of
// piling new lines on top. New ROMs added to public/ should get an
// entry here — the LibraryPage auto-falls-back to "Unknown ROM" with no
// issues listed if the path is missing.

export type RomTier = '🟢' | '🟡' | '🔴' | '🧪';

export interface RomMeta {
  /** Path under public/, including leading slash. */
  path: string;
  /** Short display label for cards. */
  label: string;
  /** Category — 'retail' commercial games, 'test' for PPU regression demos. */
  kind: 'retail' | 'test';
  /** Status emoji shown on the card + detail header. */
  tier: RomTier;
  /** Optional one-line summary surfaced under the label on the detail page. */
  blurb?: string;
  /** Known issues the player should expect when running this ROM. */
  issues: string[];
}

export const ROM_LIBRARY: RomMeta[] = [
  // ──────────────────── 🟢 Visible content ────────────────────
  {
    path: '/Super Mario 64 DS.nds',
    label: 'Super Mario 64 DS',
    kind: 'retail',
    tier: '🟢',
    blurb: 'Title screen visible. Touch/button input reaches the SDK but the title-state-machine gate to advance into level-select is not satisfied.',
    issues: [
      'Title screen renders but pressing A/START/touch does not advance.',
      '3D engine completeness: no per-vertex lighting, edge marking, fog, or anti-aliasing.',
      'In-game content not yet reachable.',
    ],
  },
  {
    path: '/Brain Training.nds',
    label: 'Brain Training',
    kind: 'retail',
    tier: '🟢',
    blurb: 'Renders the language-select / intro text on the top screen.',
    issues: [
      'Touch input not registered for language selection (SDK touch driver writes zeros to its touch struct).',
      'Bottom screen stays blank — Engine B has no BG layers enabled yet by this game state.',
      'No microphone modeling, so voice exercises will not work.',
    ],
  },
  {
    path: '/Cooking Mama (USA).nds',
    label: 'Cooking Mama',
    kind: 'retail',
    tier: '🟢',
    blurb: 'Tile-based UI rendering (cream/orange Cooking Mama palette).',
    issues: [
      'Tap-to-progress not yet driving past the intro tile screen.',
      'No microphone — blow / shout interactions unavailable.',
    ],
  },
  {
    path: '/Simpsons Game, The (USA).nds',
    label: 'The Simpsons Game',
    kind: 'retail',
    tier: '🟢',
    blurb: '20th Century Fox + Simpsons intro plays. Save chip detection works (1-byte EEPROM, game code YSZE).',
    issues: [
      'Intro video may feel slow on busy frames — the ARM9 JS emulation is compute-heavy during streamed video.',
      'Save chip "could not be accessed" message is FIXED.',
    ],
  },
  {
    path: '/Age of Empires - Mythologies (USA) (En,Fr).nds',
    label: 'Age of Empires: Mythologies',
    kind: 'retail',
    tier: '🟢',
    blurb: 'Griptonite + Ensemble Studios logos render. Save chip = 2-byte EEPROM (game code CEPE).',
    issues: [
      'Mythologies title between the studio logos has affine-BG rendering artifacts in one band.',
      'Game stalls at the main menu — touch state-machine gate not satisfied.',
      '"Could not access save data" message is FIXED.',
    ],
  },
  {
    path: '/Spider-Man - Edge of Time (USA) (En,Fr).nds',
    label: 'Spider-Man: Edge of Time',
    kind: 'retail',
    tier: '🟢',
    blurb: 'Spider-Man logo + web background render on top. Save chip = EEPROM 0.5K (1-byte addr, game code B8IE).',
    issues: [
      'Bottom-screen menu BG is garbled — looks like one BG layer reading data the game expects to be affine-transformed.',
      '"Save data could not be accessed" message is FIXED.',
    ],
  },
  {
    path: "/Tony Hawk's Proving Ground (USA).nds",
    label: "Tony Hawk's Proving Ground",
    kind: 'retail',
    tier: '🟢',
    blurb: 'Bottom screen renders 800+ distinct colors (skater preview UI) via affine BG.',
    issues: [
      'Top screen renders with a strong red tint on some BG layers — palette interpretation in the extended-bitmap mode.',
      'In-game 3D level not yet reached.',
    ],
  },
  {
    path: '/Pokemon Mystery Dungeon - Blue Rescue Team (USA).nds',
    label: 'PMD: Blue Rescue Team',
    kind: 'retail',
    tier: '🟢',
    blurb: '170-color title-screen render after affine BG support landed.',
    issues: [
      'Cannot advance past the title screen yet — touch/button gate.',
      'In the team-roster menu, list-item text shows garbled characters ("ðG-é DMâ" pattern) while the section header reads correctly. Investigation deferred: headless tests can\'t drive the SDK touch driver to reach the menu, so the broken state\'s VRAMCNT/DISPCNT/BGCNT bytes haven\'t been captured. Use the 📸 Snapshot button on the player when the bug is visible to grab a JSON dump for follow-up.',
    ],
  },
  {
    path: '/Nintendo DS Browser (USA, Europe) (En,Fr,De,Es,It).nds',
    label: 'Nintendo DS Browser',
    kind: 'retail',
    tier: '🟢',
    blurb: 'Browser splash + UI renders (40+ colors). Massive VRAM usage.',
    issues: [
      'WiFi connectivity not modeled — cannot actually load web pages.',
      'Touch keyboard input has not been wired through.',
    ],
  },

  // ──────────────────── 🟡 Boots, partial render ────────────────────
  {
    path: '/LEGO Star Wars - The Complete Saga (USA).nds',
    label: 'LEGO Star Wars: The Complete Saga',
    kind: 'retail',
    tier: '🟡',
    blurb: '273K VRAM loaded — engine A renders the 3D scene; engine B mirrors via captured tiles.',
    issues: [
      'Both screens show identical 3D output — intentional game design (engine B mirrors engine A).',
      'Logo screen state-machine never advances past loading.',
    ],
  },
  {
    path: '/LEGO Indiana Jones - The Original Adventures (USA) (En,Fr,De,Es,It,Da).nds',
    label: 'LEGO Indiana Jones',
    kind: 'retail',
    tier: '🟡',
    blurb: '262K VRAM loaded. Same engine state-machine pattern as LEGO Star Wars.',
    issues: [
      'Stalls in the same SDK loading state as LEGO Star Wars.',
    ],
  },
  {
    path: '/Cars (USA).nds',
    label: 'Cars',
    kind: 'retail',
    tier: '🟡',
    blurb: 'Display configured but minimal visible content.',
    issues: [
      'Stalls very early in the loading sequence.',
    ],
  },
  {
    path: '/Need for Speed - ProStreet (USA) (En,Fr,De,Es,It) (Rev 1).nds',
    label: 'NFS: ProStreet',
    kind: 'retail',
    tier: '🟡',
    blurb: '119K VRAM, BG layers configured, 3-color render.',
    issues: [
      'Stalls at an early loading screen.',
    ],
  },
  {
    path: '/Skate It (USA) (En,Fr,De,Es,It,Nl).nds',
    label: 'Skate It',
    kind: 'retail',
    tier: '🟡',
    blurb: '50K VRAM, bottom screen partial render (4 colors).',
    issues: [
      'Stalls early.',
    ],
  },
  {
    path: '/Sonic Rush Adventure (USA) (En,Ja,Fr,De,Es,It).nds',
    label: 'Sonic Rush Adventure',
    kind: 'retail',
    tier: '🟡',
    blurb: 'Bottom screen shows what looks like a loading stripe.',
    issues: [
      'Game intentionally keeps Engine A blanked during this state.',
    ],
  },

  // ──────────────────── 🔴 Stalls early ────────────────────
  {
    path: '/New Super Mario Bros.nds',
    label: 'New Super Mario Bros.',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Full palette loaded, all display enables set, FS dispatcher actively running.',
    issues: [
      'NSMB main task waits on a thread-wake signal that requires modeling NitroSDK OS_CreateThread.',
      'No visible content yet; FS reads do land in main RAM via our assist hook.',
    ],
  },
  {
    path: '/Tetris DS.nds',
    label: 'Tetris DS',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Reaches an explicit SDK OS_Panic / B-self loop at 0x02026F54.',
    issues: [
      'A downstream validation check fails after our SNDi PXI fix advanced it past the original SNDi loop.',
    ],
  },
  {
    path: '/Nintendogs - Labrador.nds',
    label: 'Nintendogs - Labrador',
    kind: 'retail',
    tier: '🔴',
    blurb: '104K VRAM loaded; SDK init advanced past the original PXI deadlock.',
    issues: [
      'Reaches deeper SDK boot but no visible display state.',
      'Requires microphone for "name your puppy" voice training (we do not model the mic).',
    ],
  },
  {
    path: '/Pokemon - Platinum Version (USA) (Rev 1).nds',
    label: 'Pokemon Platinum',
    kind: 'retail',
    tier: '🔴',
    blurb: 'ARM9 reaches a flag-poll state machine after SPI WEL latch fix.',
    issues: [
      'A specific bit in main-RAM never flips to the value the SDK is waiting for.',
      'Save chip WEL bit is read correctly (game-code lookup: 3-byte FLASH).',
    ],
  },
  {
    path: '/Pokemon - HeartGold Version (USA).nds',
    label: 'Pokemon HeartGold',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Same SDK family as Pokemon Platinum.',
    issues: [
      'Same state-machine gate as Pokemon Platinum.',
    ],
  },
  {
    path: '/Pokemon - Pearl Version (USA) (Rev 5).nds',
    label: 'Pokemon Pearl',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Same SDK family as Pokemon Platinum.',
    issues: [
      'Same state-machine gate.',
    ],
  },
  {
    path: '/1284 - Pokemon Diamond Version (v1.13) (E)(Independent).nds',
    label: 'Pokemon Diamond',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Same SDK family.',
    issues: ['Same state-machine gate.'],
  },
  {
    path: '/Meteos.nds',
    label: 'Meteos',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Boots into idle waiting for ARM7 PXI subsystem reply.',
    issues: [
      'Meteos uses PXI tag 0x05 — our stub PXI server only acks the exact Meteos init word.',
      'After the first ack, the SDK expects further follow-up replies we do not synthesize.',
    ],
  },
  {
    path: '/Ben 10 Triple Pack (USA) (En,Fr,De,Es,It).nds',
    label: 'Ben 10 Triple Pack',
    kind: 'retail',
    tier: '🔴',
    blurb: '170K VRAM loaded but no visible composition.',
    issues: ['Stalls before display enables fire.'],
  },
  {
    path: '/Dogz (USA).nds',
    label: 'Dogz',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Minimal VRAM activity.',
    issues: ['Stalls very early.'],
  },
  {
    path: '/Grand Theft Auto - Chinatown Wars (USA) (En,Fr,De,Es,It).nds',
    label: 'GTA: Chinatown Wars',
    kind: 'retail',
    tier: '🔴',
    blurb: '3D engine initialized.',
    issues: ['Stalls before any visible content.'],
  },
  {
    path: '/Legend of Zelda, The - Spirit Tracks (USA) (En,Fr,Es) (Rev 1).nds',
    label: 'Zelda: Spirit Tracks',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Display modes set but VRAM stays empty.',
    issues: ['Stalls very early — 5 reads/frame, ARM9 mostly halted.'],
  },
  {
    path: '/Apollo Justice - Ace Attorney (USA).nds',
    label: 'Apollo Justice: Ace Attorney',
    kind: 'retail',
    tier: '🔴',
    blurb: 'No display init.',
    issues: ['Stalls early.'],
  },
  {
    path: "/SpongeBob's Atlantis SquarePantis (USA).nds",
    label: 'SpongeBob Atlantis SquarePantis',
    kind: 'retail',
    tier: '🔴',
    blurb: 'No display init.',
    issues: ['Stalls early.'],
  },
  {
    path: '/Toy Story 3 (USA) (En,Fr,Es) (NDSi Enhanced).nds',
    label: 'Toy Story 3 (DSi)',
    kind: 'retail',
    tier: '🔴',
    blurb: 'NDSi Enhanced — we do not model DSi-specific features.',
    issues: [
      'Game uses DSi-extended hardware that the emulator does not implement.',
    ],
  },
  {
    path: '/Sims 3, The (USA) (En,Fr,Es) (NDSi Enhanced).nds',
    label: 'The Sims 3 (DSi)',
    kind: 'retail',
    tier: '🔴',
    blurb: 'NDSi Enhanced — not modeled.',
    issues: ['Game requires DSi-specific features.'],
  },
  {
    path: '/Art Academy (USA) (NDSi Enhanced).nds',
    label: 'Art Academy (DSi)',
    kind: 'retail',
    tier: '🔴',
    blurb: 'NDSi Enhanced — not modeled.',
    issues: ['Game requires DSi camera + extended features.'],
  },
  {
    path: '/Plants vs. Zombies (USA).nds',
    label: 'Plants vs. Zombies',
    kind: 'retail',
    tier: '🔴',
    blurb: 'No display init.',
    issues: ['Stalls in early init.'],
  },
  {
    path: '/Disney Princess - Magical Jewels (USA).nds',
    label: 'Disney Princess: Magical Jewels',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Stalls before display init.',
    issues: ['Stalls early.'],
  },
  {
    path: '/LEGO Battles - Ninjago (USA) (En,Fr,Es).nds',
    label: 'LEGO Battles: Ninjago',
    kind: 'retail',
    tier: '🔴',
    blurb: 'Same SDK family as other LEGO games.',
    issues: ['Stalls before LEGO Star Wars-style render phase.'],
  },

  // ──────────────────── 🧪 PPU regression tests / homebrew ────────────────────
  {
    path: '/rockwrestler.nds',
    label: 'RockWrestler',
    kind: 'test',
    tier: '🧪',
    blurb: 'Homebrew memory-test ROM — used to verify ARM7/ARM9 IPC + WRAM bank routing.',
    issues: [],
  },
  {
    path: '/test_obj_mosaic.nds',
    label: 'OBJ mosaic test',
    kind: 'test',
    tier: '🧪',
    blurb: 'Regression test for sprite mosaic effect.',
    issues: [],
  },
  {
    path: '/test_obj_prio.nds',
    label: 'OBJ priority test',
    kind: 'test',
    tier: '🧪',
    blurb: 'Regression test for sprite priority sort.',
    issues: [],
  },
  {
    path: '/test_obj_mos_fuzz.nds',
    label: 'OBJ mosaic fuzz',
    kind: 'test',
    tier: '🧪',
    blurb: 'Fuzz harness for sprite mosaic edge cases.',
    issues: [],
  },
];

/** Look up a ROM's metadata by its path. Returns null if not registered. */
export function getRomMeta(path: string): RomMeta | null {
  return ROM_LIBRARY.find((r) => r.path === path) ?? null;
}

/** URL-safe slug for routing. The `:slug` route param uses this. */
export function romSlug(path: string): string {
  return encodeURIComponent(path.replace(/^\//, ''));
}

/** Reverse of romSlug — recover the path from a route param. */
export function pathFromSlug(slug: string): string {
  return '/' + decodeURIComponent(slug);
}
