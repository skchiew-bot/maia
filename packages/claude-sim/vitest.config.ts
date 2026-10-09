import { defineProject } from 'vitest/config';

export default defineProject({
  // Many tests spawn real processes (the sim, MCP servers, hooks); leave headroom for a busy CI machine.
  test: {
    name: 'claude-sim',
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 60000,
  },
});
