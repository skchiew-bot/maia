import { defineProject } from 'vitest/config';

// Each file boots its own aocd on port 0 and spawns real node processes (hooks, MCP server, sidecar),
// so timeouts are generous and files run in separate forks.
export default defineProject({
  test: {
    name: 'e2e',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
