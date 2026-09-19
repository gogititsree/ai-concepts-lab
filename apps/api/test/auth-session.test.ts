import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Db } from '../src/db/client.js';
import {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  PENDING_TIMEOUT_MS,
  SESSION_TOKEN_BYTES,
  TOUCH_INTERVAL_MS,
  computeExpiry,
  isSessionActive,
  mintSessionToken,
  sessionIdFromToken,
  sessionIdHex,
  touchSession,
  type SessionRow,
} from '../src/auth/session.js';

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  const created = new Date('2025-01-01T00:00:00.000Z');
  return {
    id: Buffer.alloc(32, 7),
    userId: '00000000-0000-4000-8000-000000000000',
    mfaVerifiedAt: created,
    createdAt: created,
    lastSeenAt: created,
    expiresAt: new Date(created.getTime() + IDLE_TIMEOUT_MS),
    ip: null,
    userAgent: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('session token minting and hashing', () => {
  it('stores sha256(token), never the token itself', () => {
    const { token, id } = mintSessionToken();
    const expected = createHash('sha256').update(token, 'utf8').digest();

    expect(id.equals(expected)).toBe(true);
    expect(id).toHaveLength(32);
    // The invariant that makes a database dump useless: the stored value is not the
    // credential, and the credential cannot be derived from it.
    expect(id.toString('base64url')).not.toBe(token);
  });

  it('mints 32 bytes of randomness, base64url encoded', () => {
    const { token } = mintSessionToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(SESSION_TOKEN_BYTES);
    // base64url: no +, / or = to survive a cookie round-trip unescaped.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintSessionToken().token));
    expect(tokens.size).toBe(200);
  });

  it('is a pure function of the token', () => {
    expect(sessionIdFromToken('abc').equals(sessionIdFromToken('abc'))).toBe(true);
    expect(sessionIdFromToken('abc').equals(sessionIdFromToken('abd'))).toBe(false);
    expect(sessionIdHex(sessionIdFromToken('abc'))).toHaveLength(64);
  });
});

describe('computeExpiry', () => {
  const createdAt = new Date('2025-01-01T00:00:00.000Z');

  it('gives a pending-MFA session a flat 10 minutes from creation', () => {
    const expiry = computeExpiry({ createdAt, lastSeenAt: createdAt, mfaVerified: false });
    expect(expiry.getTime()).toBe(createdAt.getTime() + PENDING_TIMEOUT_MS);
  });

  it('ignores activity on a pending session — it cannot be extended by using it', () => {
    const lastSeenAt = new Date(createdAt.getTime() + 9 * 60 * 1000);
    const expiry = computeExpiry({ createdAt, lastSeenAt, mfaVerified: false });
    expect(expiry.getTime()).toBe(createdAt.getTime() + PENDING_TIMEOUT_MS);
  });

  it('uses the idle deadline for a young, active session', () => {
    const lastSeenAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
    const expiry = computeExpiry({ createdAt, lastSeenAt, mfaVerified: true });
    expect(expiry.getTime()).toBe(lastSeenAt.getTime() + IDLE_TIMEOUT_MS);
  });

  it('caps an active session at the absolute deadline', () => {
    // 29 days in: idle would say day 36, the absolute cap says day 30, and the cap wins.
    const lastSeenAt = new Date(createdAt.getTime() + 29 * 24 * 60 * 60 * 1000);
    const expiry = computeExpiry({ createdAt, lastSeenAt, mfaVerified: true });
    expect(expiry.getTime()).toBe(createdAt.getTime() + ABSOLUTE_TIMEOUT_MS);
  });
});

describe('isSessionActive', () => {
  const now = new Date('2025-01-02T00:00:00.000Z');

  it('accepts a live session', () => {
    expect(isSessionActive(sessionRow(), now)).toBe(true);
  });

  it('rejects a revoked session even before it expires', () => {
    expect(isSessionActive(sessionRow({ revokedAt: now }), now)).toBe(false);
  });

  it('rejects an expired session', () => {
    expect(isSessionActive(sessionRow({ expiresAt: new Date(now.getTime() - 1) }), now)).toBe(
      false,
    );
  });
});

describe('touchSession', () => {
  // Any query at all fails the test: the point of the 5-minute rule is that a burst of
  // requests performs zero writes.
  const forbiddenDb = new Proxy(
    {},
    {
      get() {
        throw new Error('touchSession must not touch the database inside the 5-minute window');
      },
    },
  ) as Db;

  it('does nothing when last_seen_at is fresher than the interval', async () => {
    const session = sessionRow();
    const soon = new Date(session.lastSeenAt.getTime() + TOUCH_INTERVAL_MS - 1000);

    await expect(touchSession(forbiddenDb, session, soon)).resolves.toBe(session);
  });

  it('writes once the interval has passed, sliding the idle window', async () => {
    const session = sessionRow();
    const later = new Date(session.lastSeenAt.getTime() + TOUCH_INTERVAL_MS + 1000);
    const writes: Array<{ lastSeenAt: Date; expiresAt: Date }> = [];

    // Minimal stand-in for the Drizzle update builder chain; the integration suite covers
    // the real SQL, this covers the decision to issue it at all.
    const db = {
      update: () => ({
        set: (values: { lastSeenAt: Date; expiresAt: Date }) => {
          writes.push(values);
          return { where: () => ({ returning: async () => [{ ...session, ...values }] }) };
        },
      }),
    } as unknown as Db;

    const updated = await touchSession(db, session, later);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.lastSeenAt).toEqual(later);
    expect(writes[0]?.expiresAt.getTime()).toBe(later.getTime() + IDLE_TIMEOUT_MS);
    expect(updated.lastSeenAt).toEqual(later);
  });
});
