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
  /** Seconds to wait for a new connection to be established. */
  connectTimeout?: number;
  /** Seconds an unused connection is kept before it is closed. */
  idleTimeout?: number;
}

/**
 * Pool timings (M13), sized for **Render free + a pooled Neon endpoint**. Each number is
 * a tradeoff, not a default someone liked:
 *
 * `IDLE_TIMEOUT_SECONDS = 30` — postgres.js keeps idle connections open forever unless
 * told otherwise. On Neon's free plan that is actively harmful in two ways: idle client
 * connections occupy slots in the pooler that the pre-deploy migration job and any
 * ad-hoc `psql` also need, and an always-open connection is exactly the thing that keeps
 * a scale-to-zero compute awake and burning the monthly allowance. The cost of closing
 * them is one TCP+TLS handshake on the next request after half a minute of silence —
 * which, on a free instance that the platform puts to sleep after fifteen minutes
 * anyway, is a rounding error next to the cold start the user already absorbed.
 *
 * `CONNECT_TIMEOUT_SECONDS = 10` — long enough for Neon to resume a suspended compute
 * (single-digit seconds, and the *first* connection after a sleep is the slow one),
 * short enough that a genuinely unreachable database surfaces as a failed request rather
 * than as a hung one. A request that waits 60 s for a connection has already lost the
 * user; it just has not told them yet.
 *
 * `MAX_LIFETIME_SECONDS = 900` — connections are recycled every ~15 minutes even when
 * busy. A long-lived connection through a proxy that may itself be redeployed, rotated
 * or scaled is a connection that will eventually be closed *by someone else*, mid-query;
 * retiring them on our own schedule turns that into a handshake instead of an error.
 */
export const IDLE_TIMEOUT_SECONDS = 30;
export const CONNECT_TIMEOUT_SECONDS = 10;
export const MAX_LIFETIME_SECONDS = 900;

/**
 * Does this connection string point at a transaction-mode connection pooler?
 *
 * Neon's pooled endpoint is the same host with `-pooler` inserted
 * (`ep-x-123-pooler.eu-central-1.aws.neon.tech`), and `?pgbouncer=true` is the
 * convention other providers use. It matters because postgres.js uses **named prepared
 * statements** by default, and in transaction pooling mode consecutive queries from one
 * client can land on different server connections — so a prepared statement is either
 * missing (`prepared statement "s1" does not exist`) or duplicated, depending on which
 * way the deal goes. Neon's pooler does implement prepared-statement tracking, but this
 * is a failure that can only appear in production, cannot appear in CI (which runs a
 * direct `postgres:16-alpine`), and costs nothing to rule out: this app's queries are
 * small and infrequent, so the plan-caching that `prepare` buys is not measurable here.
 *
 * Exported for the test, and because "which mode am I in?" is a question the runbook
 * asks.
 */
export function isPooledConnectionString(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('-pooler.') || parsed.searchParams.get('pgbouncer') === 'true';
  } catch {
    return false;
  }
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
    connect_timeout: opts.connectTimeout ?? CONNECT_TIMEOUT_SECONDS,
    idle_timeout: opts.idleTimeout ?? IDLE_TIMEOUT_SECONDS,
    max_lifetime: MAX_LIFETIME_SECONDS,
    // Only through a transaction-mode pooler; a direct connection (local, CI) keeps
    // prepared statements. See `isPooledConnectionString`.
    prepare: !isPooledConnectionString(url),
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
