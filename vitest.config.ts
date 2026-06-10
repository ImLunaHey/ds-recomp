import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Run test FILES in parallel across multiple worker threads.
    // (Default but spelled out for clarity.)
    pool: 'threads',
    fileParallelism: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      // Headless test ROM scripts (test/boot.ts, test/long.ts,
      // test/probe.ts, test/rockwrestler.ts) are scratch probes, not
      // production code. Exclude UI + main entry points too — they're
      // exercised by browser interaction, not unit tests.
      include: ['src/cpu/**', 'src/memory/**', 'src/io/**', 'src/ppu/**', 'src/bios/**', 'src/cart/**'],
      exclude: [
        'src/cpu/disasm.ts',     // UI-only
        'src/test/**',
        'src/ui/**',
        'src/main.tsx',
        'src/emulator.ts',
      ],
    },
  },
});
