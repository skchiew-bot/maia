import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'demo', environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 60000 },
});
