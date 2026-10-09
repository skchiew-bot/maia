import { defineConfig } from 'vitest/config';

// Opt-in: `AOC_REAL_CLI=1 pnpm --filter @aoc/e2e real-cli`. These files run the real `claude` CLI against the platform,
// so they are not part of the e2e project (vitest.config.ts) and never run in `pnpm test`. One file at a time: they
// share one plan quota and every scenario takes minutes.
export default defineConfig({
  test: {
    name: 'e2e-real-cli',
    environment: 'node',
    include: ['real-cli/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    isolate: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
