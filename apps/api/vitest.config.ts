import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit suite. Integration tests live in `test/integration/` and are excluded here: they
 * need a real Postgres, and `pnpm test` must stay runnable on a laptop with nothing
 * running. See `vitest.integration.config.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its source so `pnpm test` works on a cold
      // clone, before `pnpm build` has produced packages/shared/dist.
      '@lab/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    env: {
      NODE_ENV: 'test',
      // src/config.ts requires DATABASE_URL, and importing the app reaches it. No unit
      // test opens a socket (postgres.js connects lazily), so any valid URL will do;
      // a real one from the environment is preferred so the value is never misleading.
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://lab:lab@localhost:5432/lab',
    },
  },
});
