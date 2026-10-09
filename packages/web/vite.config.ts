import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:7420', '/portal/api': 'http://127.0.0.1:7420' } },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // @aoc/contracts builds its zod event schemas at import time. Its sources are pure, so only the modules whose
    // exports the UI uses (labels, small pure functions) may be bundled, not the whole barrel.
    rollupOptions: { treeshake: { moduleSideEffects: (id) => !/[\\/]packages[\\/]contracts[\\/]src[\\/]/.test(id) } },
  },
  test: { name: 'web', environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'] },
});
