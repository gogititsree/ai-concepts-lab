import { createHash, randomBytes } from 'node:crypto';

import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

/**
 * Session lifecycle: mint, look up, touch, revoke.
 *
 * The shape of the thing, from `docs/03-auth-mfa.md`: the cookie holds 32 random bytes as
 * base64url; the database stores `sha256(token)` as the primary key. A dump of `sessions`
 * therefore contains no usable credentials — the attacker would have to invert SHA-256 to
 * turn a row into a cookie. There is no HMAC and no per-row salt because the input is
 * already 256 bits of uniform randomness: rainbow tables and brute force are both off the
 * table, and a plain hash keeps the lookup a single primary-key hit.
 */

export const SESSION_TOKEN_BYTES = 32;

/** Idle timeout: 7 days without a request ends the session. */
export const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
/** Absolute cap: 30 days after creation, however active the user has been. */
export const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
/** A pending-MFA session (login step 1 done, step 2 not) is good for 10 minutes. */
export const PENDING_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * `last_seen_at` is only written when it is this stale. Without the threshold every
 * authenticated GET would become a write, which on a single-writer Postgres turns a
 * read-mostly app into a write-mostly one for no benefit: 5-minute resolution is ample
 * for an idle timeout measured in days.
 */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface MintedToken {
  /** The value that goes in the cookie. Never stored. */
  token: string;
  /** `sha256(token)` — the value that goes in `sessions.id`. */
  id: Buffer;
}

/** `sha256` of the raw cookie value. Pure, so it is unit-testable without a database. */
export function sessionIdFromToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function mintSessionToken(): MintedToken {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  return { token, id: sessionIdFromToken(token) };
}

/**
 * When a session that started at `createdAt` and was last used at `lastSeenAt` expires.
 *
 * Full sessions get the earlier of the two deadlines, so an active user is logged out
 * after 30 days regardless and an inactive one after 7. Pending sessions ignore both and
 * get a flat 10 minutes from creation — they exist only to carry the "password accepted,
 * second factor outstanding" state across one request.
 */
export function computeExpiry(input: {
  createdAt: Date;
  lastSeenAt: Date;
  mfaVerified: boolean;
}): Date {
  if (!input.mfaVerified) {
    return new Date(input.createdAt.getTime() + PENDING_TIMEOUT_MS);
  }
  return new Date(
    Math.min(
      input.lastSeenAt.getTime() + IDLE_TIMEOUT_MS,
      input.createdAt.getTime() + ABSOLUTE_TIMEOUT_MS,
    ),
  );
}

export type SessionRow = typeof sessions.$inferSelect;
export type UserRow = typeof users.$inferSelect;

export interface CreateSessionInput {
  userId: string;
  /**
   * False creates a *pending* session. In M5 this is always true (nobody has MFA); M6
   * passes false from login step 1 when `users.mfa_enabled` is set.
   */
  mfaVerified: boolean;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  token: string;
  session: SessionRow;
}

export async function createSession(db: Db, input: CreateSessionInput): Promise<CreatedSession> {
  const { token, id } = mintSessionToken();
  const now = new Date();
  const mfaVerifiedAt = input.mfaVerified ? now : null;
  const expiresAt = computeExpiry({
    createdAt: now,
    lastSeenAt: now,
    mfaVerified: input.mfaVerified,
  });

  const [session] = await db
    .insert(sessions)
    .values({
      id,
      userId: input.userId,
      mfaVerifiedAt,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning();

  // `.returning()` on a single-row insert always yields one row; the guard exists so the
  // non-null assertion never has to.
  if (!session) throw new Error('Failed to create session');
  return { token, session };
}

export interface SessionWithUser {
  session: SessionRow;
  user: UserRow;
}

/**
 * The one query on the hot path of every authenticated request: primary-key lookup on
 * `sessions` joined to its user. Expiry and revocation are *not* filtered here — the
 * guard needs to tell "no such session" from "your session ended" in the log line, even
 * though both answer 401 to the client.
 */
export async function loadSessionWithUser(db: Db, id: Buffer): Promise<SessionWithUser | null> {
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export function isSessionActive(session: SessionRow, now: Date = new Date()): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

/**
 * Slides the idle window, at most once every `TOUCH_INTERVAL_MS`.
 *
 * Returns the row to use for the rest of the request: the updated one if it wrote,
 * otherwise the one passed in.
 */
export async function touchSession(
  db: Db,
  session: SessionRow,
  now: Date = new Date(),
): Promise<SessionRow> {
  if (now.getTime() - session.lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return session;

  const expiresAt = computeExpiry({
    createdAt: session.createdAt,
    lastSeenAt: now,
    mfaVerified: session.mfaVerifiedAt !== null,
  });
  const [updated] = await db
    .update(sessions)
    .set({ lastSeenAt: now, expiresAt })
    .where(eq(sessions.id, session.id))
    .returning();
  return updated ?? session;
}

/** Marks one session revoked. Idempotent: a second call keeps the first timestamp. */
export async function revokeSession(db: Db, id: Buffer, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** "Log out everywhere." Returns how many live sessions were ended. */
export async function revokeAllSessions(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length;
}

/**
 * Used by the password change flow: whoever just proved they know the current password
 * keeps their session, everything else dies. That is the whole point of changing a
 * password after a suspected compromise.
 */
export async function revokeOtherSessions(
  db: Db,
  userId: string,
  keepId: Buffer,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), ne(sessions.id, keepId)))
    .returning({ id: sessions.id });
  return rows.length;
}

export async function listActiveSessions(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<SessionRow[]> {
  return db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
    )
    .orderBy(sessions.createdAt);
}

/**
 * Resolves the id shown by `GET /auth/sessions` (8 hex chars) back to a full session id,
 * scoped to the calling user so one account can never revoke another's session by
 * guessing a prefix. A full 64-character id is accepted too and short-circuits the LIKE.
 *
 * 8 hex characters is 32 bits, so two live sessions *could* collide; the query returns at
 * most one row and the caller treats "no unique match" as 404, which is the right answer
 * for a UI that is showing exactly these prefixes.
 */
export async function findSessionIdByPrefix(
  db: Db,
  userId: string,
  prefix: string,
): Promise<Buffer | null> {
  const normalised = prefix.toLowerCase();
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.userId, userId), sql`encode(${sessions.id}, 'hex') LIKE ${`${normalised}%`}`),
    )
    .limit(2);
  if (rows.length !== 1) return null;
  return rows[0]?.id ?? null;
}

/** Hex form of a session id; the first 8 characters are what the API exposes. */
export function sessionIdHex(id: Buffer): string {
  return id.toString('hex');
}
