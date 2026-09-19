import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import { config } from '../config.js';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * The handle inside a `db.transaction(async (tx) => ...)` callback. Derived from `Db`
 * rather than spelled out as `PgTransaction<PostgresJsQueryResultHKT, ...>` so it cannot
 * drift from whatever Drizzle actually hands over.
 */
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * "A thing you can run queries on." Helpers that a caller may want to run either standalone
 * or inside a transaction take this, which is how `replaceBackupCodes` can be called from
 * the enrollment transaction and from the regenerate route alike.
 */
export type DbLike = Db | DbTransaction;

export interface DbClient {
  db: Db;
  /** The raw postgres.js handle, for `EXPLAIN`, `LISTEN`, and test fixtures. */
  sql: Sql;
  close(): Promise<void>;
}

export interface CreateDbClientOptions {
  /** Defaults to `config.DB_POOL_MAX`. */
  max?: number;
  /** Seconds a query may run before postgres.js aborts it. 0 disables the timeout. */
  connectTimeout?: number;
}

/**
 * Builds an independent pool. The app uses the module-level `db` below; the integration
 * harness uses this directly so each test file can point at its own database.
 *
 * Note that postgres.js connects lazily: constructing the client opens no socket, which is
 * what lets unit tests import the app (and therefore this module) with no Postgres around.
 */
export function createDbClient(url: string, opts: CreateDbClientOptions = {}): DbClient {
  const sql = postgres(url, {
    max: opts.max ?? config.DB_POOL_MAX,
    connect_timeout: opts.connectTimeout ?? 10,
    // Drizzle handles its own type parsing; leaving `transform` at the default keeps
    // column names exactly as written in schema.ts.
    onnotice: () => {},
  });
  return {
    db: drizzle(sql, { schema }),
    sql,
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

const client = createDbClient(config.DATABASE_URL);

/** The application's Drizzle instance. */
export const db: Db = client.db;

/** The application's raw postgres.js handle. */
export const sql: Sql = client.sql;

/** Closes the application pool; called from the server's shutdown path. */
export async function closeDb(): Promise<void> {
  await client.close();
}
