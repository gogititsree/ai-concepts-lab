import { randomBytes } from 'node:crypto';

import { createDbClient, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/db/seed.js';
import type { Sql } from 'postgres';

/**
 * Integration-test isolation: **one throwaway database per test file.**
 *
 * The obvious alternative — one Postgres *schema* per file plus a `search_path` — does not
 * survive contact with drizzle-kit. The generated DDL qualifies enums and the view as
 * `"public"."exercise_kind"`, `"public"."v_user_module_progress"` and so on, so a second
 * schema would try to create types that already exist in `public` and the migration would
 * fail. Rewriting that SQL at test time would mean the tests no longer exercise the
 * migration that production runs, which defeats the purpose.
 *
 * `CREATE DATABASE … TEMPLATE template0` costs roughly 100–200 ms per file and gives
 * complete isolation: files can run in parallel, one file's DROP cannot affect another,
 * and the migration under test is byte-for-byte the one that ships.
 *
 * Usage:
 *
 * ```ts
 * const ctx = await setupTestDb();      // beforeAll
 * await ctx.teardown();                 // afterAll
 * ```
 */

export interface TestDb {
  /** Name of the throwaway database, e.g. `lab_test_9f2c1a08`. */
  name: string;
  url: string;
  db: Db;
  sql: Sql;
  /** Re-runs the seed against this database (used by the idempotency test). */
  reseed: () => Promise<void>;
  teardown: () => Promise<void>;
}

export interface SetupTestDbOptions {
  /** Skip `seed()` — for tests that want an empty but migrated schema. */
  seed?: boolean;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Integration tests need a real Postgres: run `pnpm db:up` ' +
        'and export DATABASE_URL=postgres://lab:lab@localhost:5432/lab',
    );
  }
  return url;
}

/** Swaps the database name in a connection string, keeping credentials and options. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function setupTestDb(options: SetupTestDbOptions = {}): Promise<TestDb> {
  const baseUrl = requireDatabaseUrl();
  const name = `lab_test_${randomBytes(4).toString('hex')}`;

  // CREATE/DROP DATABASE cannot run inside a transaction, so this admin handle is
  // deliberately separate from the one the tests use and is closed immediately.
  const admin = createDbClient(baseUrl, { max: 1 });
  try {
    await admin.sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
  } catch (error) {
    await admin.close();
    throw new Error(
      `Could not create the test database (is Postgres reachable? try \`pnpm db:up\`): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await admin.close();

  const url = withDatabase(baseUrl, name);
  // max: 2 — enough for a transaction plus an observing query, few enough that a leaked
  // connection shows up as a hang in one file rather than exhausting the server.
  const client = createDbClient(url, { max: 2 });

  await runMigrations(client.db);
  const runSeed = () => seed(client.db, { quiet: true }).then(() => undefined);
  if (options.seed !== false) await runSeed();

  return {
    name,
    url,
    db: client.db,
    sql: client.sql,
    reseed: runSeed,
    async teardown() {
      await client.close();
      const dropper = createDbClient(baseUrl, { max: 1 });
      try {
        // A connection that outlived the pool would make DROP DATABASE block forever.
        await dropper.sql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
        );
        await dropper.sql.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await dropper.close();
      }
    },
  };
}
