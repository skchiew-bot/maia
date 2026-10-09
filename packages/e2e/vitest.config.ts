import { defineProject } from 'vitest/config';

// Each file boots its own aocd on port 0 and spawns real node processes (hooks, MCP server, sidecar, claude-sim),
// bundled once by the global setup, so timeouts are generous and files run in forks.
export default defineProject({
  test: {
    name: 'e2e',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    pool: 'forks',
    // Every file builds its own daemon, store and processes; sharing the evaluated modules (the daemon with all of
    // its modules) across the files of a worker saves seconds of CPU per file.
    isolate: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
