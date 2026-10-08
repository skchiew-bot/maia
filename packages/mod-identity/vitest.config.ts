import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'mod-identity', environment: 'node', include: ['test/**/*.test.ts', 'src/**/*.test.ts'], testTimeout: 20000 },
});
