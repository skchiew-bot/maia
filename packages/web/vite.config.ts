import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:7420', '/portal/api': 'http://127.0.0.1:7420' } },
  build: { outDir: 'dist', sourcemap: true },
  test: { name: 'web', environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'] },
});
