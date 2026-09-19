import { and, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { createDbClient, type Db } from '../db/client.js';
import { mfaTotp, sessions } from '../db/schema.js';
import { isMainModule } from '../lib/isMainModule.js';

/**
 * Housekeeping for the auth tables (`docs/03-auth-mfa.md` → Housekeeping).
 *
 * Nothing here is required for correctness: the guard already refuses an expired session,
 * so a stale row is inert. It is a *retention* job. Session rows carry an IP and a
 * user-agent, and keeping them for years after they stopped working is data you have to
 * protect for no benefit.
 */

/**
 * Expired sessions are kept for a week before deletion. The delay is deliberate: during
 * an incident, "which sessions existed last Tuesday and from where" is exactly the
 * question being asked, and a cleanup job that runs the instant a session expires
 * destroys the evidence.
 */
export const EXPIRED_SESSION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Enrollment rows that were never confirmed (M6 writes them) die after an hour. */
export const PENDING_MFA_TTL_MS = 60 * 60 * 1000;

/** Hourly. The work is two indexed deletes; more often would be pure noise. */
export const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;

export interface CleanupResult {
  sessionsDeleted: number;
  pendingMfaDeleted: number;
}

export async function cleanupExpiredSessions(
  db: Db,
  now: Date = new Date(),
): Promise<CleanupResult> {
  // `sessions_expires_at_idx` exists for exactly this scan.
  const deletedSessions = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(now.getTime() - EXPIRED_SESSION_GRACE_MS)))
    .returning({ id: sessions.id });

  const deletedPendingMfa = await db
    .delete(mfaTotp)
    .where(
      and(
        isNull(mfaTotp.confirmedAt),
        lt(mfaTotp.createdAt, new Date(now.getTime() - PENDING_MFA_TTL_MS)),
      ),
    )
    .returning({ userId: mfaTotp.userId });

  return {
    sessionsDeleted: deletedSessions.length,
    pendingMfaDeleted: deletedPendingMfa.length,
  };
}

export interface HousekeepingHandle {
  stop(): void;
}

/**
 * Starts the hourly timer.
 *
 * Called from `server.ts`, never from `buildApp`: a test that builds an app must not
 * acquire a timer and a database connection it did not ask for. `unref()` means the timer
 * cannot by itself keep the process alive during shutdown.
 */
export function startHousekeeping(app: FastifyInstance): HousekeepingHandle {
  const run = (): void => {
    void cleanupExpiredSessions(app.db)
      .then((result) => {
        if (result.sessionsDeleted > 0 || result.pendingMfaDeleted > 0) {
          app.log.info(result, 'auth housekeeping removed stale rows');
        }
      })
      .catch((error: unknown) => {
        // A failed cleanup is a log line, never a crash: it is maintenance, and the next
        // tick will try again.
        app.log.warn({ err: error }, 'auth housekeeping failed');
      });
  };

  const timer = setInterval(run, HOUSEKEEPING_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * CLI form, for `pnpm --filter api cleanup` — the same function behind a schedule that
 * is not this process (a GitHub Actions cron, say) when the app runs on more than one
 * instance or is asleep on a free tier.
 */
async function main(): Promise<void> {
  const client = createDbClient(config.DATABASE_URL, { max: 1 });
  try {
    const result = await cleanupExpiredSessions(client.db);
    console.log(
      `Deleted ${result.sessionsDeleted} expired session(s) and ${result.pendingMfaDeleted} pending MFA enrollment(s).`,
    );
  } finally {
    await client.close();
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
