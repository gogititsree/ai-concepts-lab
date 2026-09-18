import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Pick up the repo-root .env like `pnpm db:migrate` does; real env vars take precedence.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  /* no .env: DATABASE_URL must come from the environment (CI) */
}

/**
 * Integration suite: real Postgres, no mocks. `DATABASE_URL` must point at a server the
 * test user can `CREATE DATABASE` on (`pnpm db:up` provides one); the harness in
 * `test/setup/db.ts` then gives every file its own throwaway database.
 *
 * There is deliberately no skip-if-unreachable path. A silently skipped integration suite
 * is worse than a red one -- it is how a broken migration reaches production.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@lab/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    // Creating and dropping a database per file is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
