import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  // Command tests spawn real processes (slow under antivirus / load), so allow generous time per test.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 30_000 },
});
