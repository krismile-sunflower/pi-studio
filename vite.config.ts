import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src',
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
    host: '127.0.0.1',
    port: 1420,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: ['es2022', 'chrome120', 'safari17'],
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test/setup.ts',
    css: true,
  },
});
