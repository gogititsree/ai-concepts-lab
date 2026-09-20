import { defineConfig, devices } from '@playwright/test';

import { e2eDatabaseUrl } from './scripts/e2e-db.mjs';

/**
 * The one end-to-end test (docs/05-quality-and-ops.md).
 *
 * There is exactly one spec on purpose: it walks register → MFA enroll → login with a
 * real TOTP → Module 1 lesson, exercise and quiz → a Module 5 agent run. Everything it
 * touches is also covered by a unit or integration test; what only this test can prove is
 * that the *built* artifacts fit together — the Vite bundle served by Fastify from one
 * origin, a `Secure`-less session cookie surviving a real browser, SSE reaching a real
 * EventSource, and the CSRF header the SPA sends being the one the API demands.
 *
 * Chromium only. A second browser engine would double the wall clock to re-test the same
 * application logic; this suite is not about rendering differences.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
/**
 * 127.0.0.1, not `localhost`: the API's CSRF guard compares the browser's `Origin`
 * against `APP_ORIGIN` literally, and a mismatch between the two spellings is a 403 that
 * looks like a login bug.
 */
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  // Nothing here calls a model (MODEL_PROVIDER=fake), so the only genuinely slow thing is
  // the perceptron training loop at ~90 ms per epoch. Two minutes is generous for that
  // and still short enough that a hung test fails the build rather than the job timeout.
  timeout: 120_000,
  expect: { timeout: 10_000 },

  // One spec, one worker: the suite shares a database and a rate-limited API, and
  // parallelism would buy nothing while making the failure modes harder to read.
  workers: 1,
  fullyParallel: false,

  // A retry in CI absorbs the odd cold-start flake; locally a failure should stay failed
  // so it gets fixed rather than re-rolled.
  retries: process.env.CI ? 1 : 0,
  // `test.only` left in a commit must fail CI, not silently skip the rest of the suite.
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['html', { open: 'never' }], ['list']],

  use: {
    baseURL,
    // Trace only on the retry: a trace of every green run is megabytes of artifact nobody
    // opens, and the retry is exactly the run that failed once.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // Builds (unless E2E_SKIP_BUILD=1) and then runs the production entrypoint.
    command: 'node scripts/e2e-server.mjs',
    url: `${baseURL}/api/v1/health`,
    // Always a fresh process: the login and registration rate limiters are in-memory, so
    // reusing a server would fail the sixth local run of the hour for a reason that has
    // nothing to do with the code.
    reuseExistingServer: false,
    // Covers a cold `pnpm build` (tsc + Vite) on a laptop as well as the server boot.
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // The image's configuration, so the SPA is actually served by Fastify and the
      // not-found handler does the SPA history fallback (see apps/api/src/app.ts).
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      GIT_SHA: process.env.GITHUB_SHA ?? 'e2e',
      LOG_LEVEL: 'warn',
      DATABASE_URL: e2eDatabaseUrl(),
      // CLAUDE.md: never call a real model from a test.
      MODEL_PROVIDER: 'fake',
      APP_ORIGIN: baseURL,
      // NODE_ENV=production would otherwise default this to true, and a `Secure` cookie
      // is silently dropped over plain http — which presents as "login does nothing".
      COOKIE_SECURE: 'false',
      // Required in production by config.ts. Throwaway values: this database is dropped
      // and recreated on every run, so nothing encrypted with them outlives the suite.
      SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef',
      MFA_ENCRYPTION_KEY: Buffer.from('e2e-only-insecure-mfa-key-32byte').toString('base64'),
    },
  },
});
