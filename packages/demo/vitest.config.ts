import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'demo',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    // Each e2e file runs aocd and several real claude-sim sessions. One file at a time keeps a shared host's load,
    // and with it the liveness timing the tests observe, sane.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
