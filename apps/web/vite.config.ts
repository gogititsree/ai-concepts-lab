/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Bundle the workspace package from source: dev, test and build then never depend
      // on packages/shared having been compiled to dist first.
      '@lab/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The lesson Markdown lives in `content/` at the repo root, outside this Vite root, and
    // `src/content/static.ts` reads it with `import.meta.glob(..., '?raw')`. The dev server
    // refuses to serve files outside the root unless they are allow-listed. (M7 deletes the
    // static loader and this line with it.)
    fs: { allow: [repoRoot] },
    // Same origin in dev, exactly as in production where the API serves this bundle.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});
