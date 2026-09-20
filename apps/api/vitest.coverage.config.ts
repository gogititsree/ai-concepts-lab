import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Same .env handling as the integration config: a developer's repo-root .env supplies
// DATABASE_URL, and a real environment variable (CI) wins.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  /* no .env: DATABASE_URL must come from the environment (CI) */
}

/**
 * The coverage gate from docs/05-quality-and-ops.md: **90 % lines** on
 * `apps/api/src/{auth,model,progress}`.
 *
 * ## Why this runs the integration tests too
 *
 * docs/05 states the gate under the "Unit tests" heading, but the three directories it
 * names are not unit-testable to 90 % and were never meant to be: `auth/routes.ts`,
 * `auth/mfaRoutes.ts`, `model/routes.ts` and `progress/routes.ts` are Fastify plugins, and
 * the same document says the way to test them is the integration suite driving
 * `app.inject()` against a real Postgres. Measured on the unit suite alone the three
 * directories come out at 34 % / 61 % / 45 % lines; measured across unit **and**
 * integration they are 93 % / 95 % / 97 %.
 *
 * So the gate is enforced over both suites rather than lowered to fit one of them. See
 * `docs/adr/0004-e2e-and-pipeline-hardening.md`. The consequence — this config needs a
 * database, so it runs in CI's `integration` job and not in `unit` — is the price, and it
 * is cheaper than either weakening the number or writing a second, mock-shaped copy of
 * every route test.
 *
 * `vitest.config.ts` (unit only, no gate) and `vitest.integration.config.ts` (integration
 * only) are unchanged: both stay runnable on their own for fast feedback.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@lab/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // Everything: test/*.test.ts (unit) and test/integration/*.test.ts.
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test', MODEL_PROVIDER: 'fake' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // Only the gated directories are instrumented. Reporting on the whole of `src/`
      // would put a number next to files docs/05 deliberately does not gate, and a number
      // nobody is allowed to act on is noise.
      include: ['src/auth/**/*.ts', 'src/model/**/*.ts', 'src/progress/**/*.ts'],
      // Count files no test imports at all; otherwise deleting the last test for a module
      // *raises* the percentage.
      all: true,
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage-gate',
      thresholds: {
        // Lines only, and per directory, exactly as docs/05 specifies. No global gate:
        // an aggregate number lets a well-covered directory hide a bare one.
        'src/auth/**': { lines: 90 },
        'src/model/**': { lines: 90 },
        'src/progress/**': { lines: 90 },
      },
    },
  },
});
