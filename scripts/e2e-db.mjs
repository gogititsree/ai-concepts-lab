/**
 * Provisions the database the Playwright E2E runs against.
 *
 * ## Why a dedicated database rather than the dev one
 *
 * The E2E drives the *real* app: it registers a user, enrolls a second factor and writes
 * progress rows. Pointing it at `lab` would mean the suite silently mutates whatever the
 * developer was doing, and a failed run would leave a half-enrolled account behind. So it
 * gets `lab_e2e`, dropped and recreated on every run: the spec always starts from
 * "migrated + seeded content, no users", which is the only state it is written against.
 *
 * Dropping is cheap (`CREATE DATABASE ... TEMPLATE template0` is ~150 ms) and it is the
 * same isolation trick `apps/api/test/setup/db.ts` already uses per integration test file,
 * so there is one idea here rather than two.
 *
 * The run's own isolation on top of that is a randomly-named user per run (see
 * `e2e/learner-journey.spec.ts`): re-running the spec against a database that was not
 * dropped still works, which is what makes `--repeat-each` and a retry safe.
 *
 * ## Resolution
 *
 * `DATABASE_URL` (env, else repo-root `.env`) names the *server*; the database component
 * is swapped for `E2E_DATABASE_NAME` (default `lab_e2e`). The original database is used as
 * the maintenance connection, because CREATE/DROP DATABASE cannot run inside the database
 * being dropped.
 *
 * Plain Node ESM rather than TypeScript so it needs no loader: `postgres` is resolved out
 * of `apps/api`'s dependencies (the root workspace deliberately has no database driver).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = new URL('../', import.meta.url);
const require = createRequire(new URL('apps/api/package.json', repoRoot));

export const E2E_DATABASE_NAME = process.env.E2E_DATABASE_NAME ?? 'lab_e2e';

/** `DATABASE_URL` from the environment, falling back to the repo-root `.env`. */
function baseDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    process.loadEnvFile(fileURLToPath(new URL('.env', repoRoot)));
  } catch {
    /* no .env: CI sets DATABASE_URL directly */
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set and no repo-root .env provides it. Run `pnpm db:up`, or ' +
        'export DATABASE_URL=postgres://lab:lab@localhost:5432/lab',
    );
  }
  return url;
}

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * The connection string the app under test and the migrations use. Exported so
 * `playwright.config.ts` derives it from exactly the same rule instead of a second copy.
 */
export function e2eDatabaseUrl() {
  return withDatabase(baseDatabaseUrl(), E2E_DATABASE_NAME);
}

/**
 * Runs one of the api package's TypeScript entrypoints against the E2E database.
 *
 * `node --import tsx <file>` rather than `pnpm --filter api exec …`: spawning pnpm on
 * Windows means a `.cmd` shim, which Node will only run through a shell, which in turn
 * trips DEP0190 when arguments are passed. Resolving `tsx` from `apps/api` (the cwd) needs
 * no shell at all and is one process instead of three.
 */
function runApiScript(label, entry, env) {
  process.stdout.write(`\n[e2e-db] ${label}\n`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
    cwd: fileURLToPath(new URL('apps/api/', repoRoot)),
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'null'}`);
  }
}

async function main() {
  const base = baseDatabaseUrl();
  const url = e2eDatabaseUrl();
  const postgres = require('postgres');

  const admin = postgres(base, { max: 1, onnotice: () => {} });
  try {
    process.stdout.write(`[e2e-db] recreating database "${E2E_DATABASE_NAME}"\n`);
    // A connection left open by a previous run would make DROP DATABASE block forever.
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = '${E2E_DATABASE_NAME}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${E2E_DATABASE_NAME}"`);
    await admin.unsafe(`CREATE DATABASE "${E2E_DATABASE_NAME}" TEMPLATE template0`);
  } finally {
    await admin.end();
  }

  // tsx, not the compiled dist: this has to work before `pnpm build` has ever run, and
  // the migration files themselves are the same either way.
  //
  // The `db:migrate`/`db:seed` package scripts are deliberately *not* reused: they pass
  // `--env-file-if-exists=../../.env`, which would put the developer's own DATABASE_URL
  // back and quietly migrate the wrong database.
  const env = { DATABASE_URL: url, NODE_ENV: 'test', MODEL_PROVIDER: 'fake' };
  runApiScript('migrate', 'src/db/migrate.ts', env);
  runApiScript('seed', 'src/db/seed.ts', env);

  process.stdout.write(`\n[e2e-db] ready: ${url.replace(/\/\/[^@]*@/, '//***@')}\n`);
}

// Only when executed directly; `playwright.config.ts` imports the helpers above.
// `pathToFileURL`, not string concatenation: on Windows argv[1] is `C:\...`, which is not
// a URL path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[e2e-db] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
