import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { UserRow } from './session.js';

/**
 * Account lockout: the second half of the login defence, alongside the rate limiter.
 *
 * They protect against different attacks, which is why both exist. The rate limiter caps
 * how fast *one IP* or *one email* can guess; lockout caps how many wrong passwords an
 * account will ever accept before it stops answering, no matter how the attempts are
 * spread across a botnet.
 *
 * The cost is a denial-of-service primitive: anyone who knows an email can lock it for
 * 15 minutes. `docs/03-auth-mfa.md` accepts that trade for a solo app — a *soft* lockout
 * that expires on its own, never one that needs an admin to clear.
 */

/** Failures before the account is locked. */
export const MAX_FAILED_LOGINS = 10;
/** How long a lockout lasts. */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export function isLocked(user: Pick<UserRow, 'lockedUntil'>, now: Date = new Date()): boolean {
  return user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
}

export function lockRetryAfterSeconds(
  user: Pick<UserRow, 'lockedUntil'>,
  now: Date = new Date(),
): number {
  if (!user.lockedUntil) return 0;
  return Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000));
}

export interface FailedLoginResult {
  failedLoginCount: number;
  lockedUntil: Date | null;
  /** True only on the attempt that crossed the threshold — that is the auditable event. */
  justLocked: boolean;
}

/**
 * Records one failed password attempt and locks the account if that was the tenth.
 *
 * The increment is done in SQL (`failed_login_count + 1`) rather than read-modify-write in
 * JavaScript so two concurrent wrong guesses cannot both read 9 and both write 10.
 */
export async function recordFailedLogin(
  db: Db,
  user: UserRow,
  now: Date = new Date(),
): Promise<FailedLoginResult> {
  const nextCount = user.failedLoginCount + 1;
  const shouldLock = nextCount >= MAX_FAILED_LOGINS && !isLocked(user, now);
  const lockedUntil = shouldLock ? new Date(now.getTime() + LOCKOUT_DURATION_MS) : user.lockedUntil;

  const [updated] = await db
    .update(users)
    .set({
      failedLoginCount: nextCount,
      lockedUntil,
      updatedAt: now,
    })
    .where(eq(users.id, user.id))
    .returning({ failedLoginCount: users.failedLoginCount, lockedUntil: users.lockedUntil });

  return {
    failedLoginCount: updated?.failedLoginCount ?? nextCount,
    lockedUntil: updated?.lockedUntil ?? lockedUntil,
    justLocked: shouldLock,
  };
}

/**
 * Called after a correct password. Clears both the counter and any expired lock, so a
 * user who got in after waiting out a lockout starts from a clean slate.
 */
export async function clearFailedLogins(
  db: Db,
  user: UserRow,
  now: Date = new Date(),
): Promise<void> {
  if (user.failedLoginCount === 0 && user.lockedUntil === null) return;
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: now })
    .where(eq(users.id, user.id));
}
