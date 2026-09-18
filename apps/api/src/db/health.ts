import type { HealthCheck } from '@lab/shared';
import type { Sql } from 'postgres';

import { sql as appSql } from './client.js';

/** How long `GET /health` waits for the database before calling it down. */
export const DB_HEALTH_TIMEOUT_MS = 2_000;

/**
 * `SELECT 1` with a hard 2 s ceiling.
 *
 * The timeout is the point: a health check that can block for the driver's full connect
 * timeout turns one sick dependency into a hung uptime probe, and the monitor then reports
 * a timeout instead of a useful status. `Promise.race` bounds the wait; both branches get
 * a handler attached, so a query that loses the race cannot surface later as an unhandled
 * rejection.
 */
export async function checkDbHealth(
  handle: Sql = appSql,
  timeoutMs: number = DB_HEALTH_TIMEOUT_MS,
): Promise<HealthCheck> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const query = handle`SELECT 1`;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      // Do not hold the event loop open just for the health-check timer.
      timer.unref?.();
    });
    await Promise.race([query, timeout]);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
