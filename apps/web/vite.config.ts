/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Bundle the workspace packages from source: dev, test and build then never depend
      // on them having been compiled to dist first.
      //
      // `@lab/nn-core` was missing here until the first CI run. Locally it resolved
      // through its `dist/`, which is always present once you have run `pnpm build` even
      // once -- so six web test files passed on every laptop and failed on a clean
      // checkout with "Failed to resolve entry for package". A stale build artefact was
      // standing in for a config entry.
      '@lab/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@lab/nn-core': fileURLToPath(
        new URL('../../packages/nn-core/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    // No `fs.allow` entry for the repo root any more: M7 deleted `src/content/static.ts`
    // and its `import.meta.glob('../../../../content/**')`, so nothing outside this Vite
    // root is read at build time. The curriculum comes from the API.
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
