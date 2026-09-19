import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { generateTotp } from '../../src/auth/totp.js';
import { loadConfig, type Config } from '../../src/config.js';
import { authEvents, mfaBackupCodes, mfaTotp, sessions, users } from '../../src/db/schema.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * The whole MFA surface against a real Postgres, driven end to end at the HTTP level:
 * enroll → confirm → log out → log in → second factor → replay → backup codes →
 * regenerate → disable.
 *
 * ## Why the clock is faked, and how
 *
 * TOTP is a function of wall-clock time, and almost every interesting property of this
 * feature (the ±1 window, replay protection via `last_used_step`) only shows up when time
 * moves. Waiting 30 real seconds between assertions would make this file take minutes.
 *
 * `vi.useFakeTimers({ toFake: ['Date'] })` fakes **only** `Date`, leaving `setTimeout` and
 * friends alone — which matters, because postgres.js drives its connection lifecycle with
 * real timers and a fully faked environment deadlocks the pool. The API computes every
 * timestamp it writes from `new Date()` in this same process, so the server and the test
 * always agree on what time it is.
 *
 * The clock starts at the real `Date.now()` and only moves forward, so the database's own
 * `now()` defaults (used by columns the API does not set explicitly) stay plausible.
 */

const APP_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };
const STEP_MS = 30_000;

let ctx: TestDb;
let app: FastifyInstance;
let config: Config;

/** The faked "now", in milliseconds. Only ever moved forward by `advance`. */
let clock = Date.now();

function advance(ms: number): void {
  clock += ms;
  vi.setSystemTime(new Date(clock));
}

/** A TOTP for this secret, `offsetSteps` periods away from the faked now. */
function codeAt(secret: string, offsetSteps = 0): string {
  return generateTotp(secret, new Date(clock + offsetSteps * STEP_MS));
}

/**
 * A code that is certain not to be a replay: step forward one period first, so the step
 * it belongs to is strictly greater than any `last_used_step` recorded so far.
 */
function freshCode(secret: string): string {
  advance(STEP_MS);
  return codeAt(secret);
}

function sessionCookie(res: InjectResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const sid = list.find((entry) => entry.startsWith('sid='));
  if (!sid) throw new Error(`No sid cookie in response: ${JSON.stringify(raw)}`);
  return sid.split(';')[0] as string;
}

const post = (url: string, payload: unknown, cookie?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: cookie ? { ...WRITE_HEADERS, cookie } : WRITE_HEADERS,
    payload: payload as Record<string, unknown>,
  });

const get = (url: string, cookie: string) =>
  app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie } });

const register = (email: string) =>
  post('/auth/register', { email, password: PASSWORD, displayName: 'Test User' });

const login = (email: string, password = PASSWORD) => post('/auth/login', { email, password });

let emailCounter = 0;
const nextEmail = (): string => `mfa${(emailCounter += 1)}@example.test`;

/** Register, enroll and confirm; returns the cookie, the email and the plaintext secrets. */
async function enrolledUser(): Promise<{
  email: string;
  cookie: string;
  secret: string;
  backupCodes: string[];
}> {
  const email = nextEmail();
  const cookie = sessionCookie(await register(email));

  const enroll = await post('/auth/mfa/enroll', { password: PASSWORD }, cookie);
  expect(enroll.statusCode).toBe(200);
  const secret: string = enroll.json().secretForManualEntry;

  const confirm = await post('/auth/mfa/confirm', { code: freshCode(secret) }, cookie);
  expect(confirm.statusCode).toBe(200);

  return { email, cookie, secret, backupCodes: confirm.json().backupCodes };
}

/** Password step only; returns the pending-session cookie. */
async function pendingSession(email: string): Promise<string> {
  const res = await login(email);
  expect(res.json()).toEqual({ status: 'mfa_required' });
  return sessionCookie(res);
}

const eventTypes = async (userId: string): Promise<string[]> => {
  const rows = await ctx.db
    .select({ type: authEvents.eventType })
    .from(authEvents)
    .where(eq(authEvents.userId, userId));
  return rows.map((row) => row.type);
};

const userIdFor = async (email: string): Promise<string> => {
  const [row] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!row) throw new Error(`No user ${email}`);
  return row.id;
};

beforeAll(async () => {
  ctx = await setupTestDb({ seed: false });
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: ctx.url,
    SESSION_SECRET: 'integration-test-session-secret-0123456789',
    APP_ORIGIN,
    // An explicit key so the suite does not depend on whatever is in the developer's .env.
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
  app = await buildApp({
    config,
    db: ctx.db,
    rateLimits: false,
    checks: { checkDb: async () => ({ ok: true }) },
  });
  await app.ready();

  // Only Date: postgres.js needs its real setTimeout. See the header comment.
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Date.now();
  vi.setSystemTime(new Date(clock));
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  await app?.close();
  await ctx?.teardown();
});

describe('enrollment', () => {
  it('hands out a QR, a URI and the secret, and stores only ciphertext', async () => {
    const email = nextEmail();
    const cookie = sessionCookie(await register(email));

    const res = await post('/auth/mfa/enroll', { password: PASSWORD }, cookie);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.secretForManualEntry).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.qrSvg.startsWith('<svg')).toBe(true);
    expect(body.otpauthUri).toContain('otpauth://totp/');
    expect(body.otpauthUri).toContain(encodeURIComponent(`AI Concepts Lab:${email}`));
    expect(body.otpauthUri).toContain('algorithm=SHA1');
    expect(body.otpauthUri).toContain('period=30');

    const userId = await userIdFor(email);
    const [row] = await ctx.db.select().from(mfaTotp).where(eq(mfaTotp.userId, userId));

    // The point of the whole crypto module: a database dump has no usable secret in it.
    expect(row?.confirmedAt).toBeNull();
    expect(row?.keyVersion).toBe(1);
    expect(row?.secretIv).toHaveLength(12);
    expect(row?.secretTag).toHaveLength(16);
    expect(Buffer.from(row!.secretCiphertext).toString('utf8')).not.toContain(
      body.secretForManualEntry,
    );

    // MFA is not on until the user has proved the app actually holds the secret.
    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(user?.mfaEnabled).toBe(false);
  });

  it('requires the current password (step-up), and does not create a row without it', async () => {
    const email = nextEmail();
    const cookie = sessionCookie(await register(email));

    const res = await post('/auth/mfa/enroll', { password: 'not the password' }, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });

    const rows = await ctx.db
      .select()
      .from(mfaTotp)
      .where(eq(mfaTotp.userId, await userIdFor(email)));
    expect(rows).toHaveLength(0);
  });

  it('refuses without a session at all', async () => {
    const res = await post('/auth/mfa/enroll', { password: PASSWORD });
    expect(res.statusCode).toBe(401);
  });

  it('confirms with a computed code, returns ten backup codes and revokes other sessions', async () => {
    const email = nextEmail();
    const firstCookie = sessionCookie(await register(email));
    // A second device, logged in before MFA existed. It must not survive enrollment.
    const secondCookie = sessionCookie(await login(email));

    const enroll = await post('/auth/mfa/enroll', { password: PASSWORD }, secondCookie);
    const secret: string = enroll.json().secretForManualEntry;

    const confirm = await post('/auth/mfa/confirm', { code: freshCode(secret) }, secondCookie);
    expect(confirm.statusCode).toBe(200);

    const { backupCodes } = confirm.json();
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);
    for (const code of backupCodes)
      expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);

    const userId = await userIdFor(email);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(user?.mfaEnabled).toBe(true);

    const [totp] = await ctx.db.select().from(mfaTotp).where(eq(mfaTotp.userId, userId));
    expect(totp?.confirmedAt).not.toBeNull();
    // Confirmation itself burns a step: the code just used cannot be replayed at login.
    expect(totp?.lastUsedStep).toBe(Math.floor(clock / 1000 / 30));

    // Hashes, never plaintext.
    const stored = await ctx.db
      .select()
      .from(mfaBackupCodes)
      .where(eq(mfaBackupCodes.userId, userId));
    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(row.codeHash.startsWith('$argon2id$')).toBe(true);
      expect(backupCodes).not.toContain(row.codeHash);
    }

    // The enrolling session survives (it just proved the factor); the other one dies.
    expect((await get('/auth/me', secondCookie)).statusCode).toBe(200);
    expect((await get('/auth/me', firstCookie)).statusCode).toBe(401);

    expect(await eventTypes(userId)).toContain('mfa_enrolled');
  });

  it('rejects a bad code, counts the attempt, and discards the enrollment after five', async () => {
    const email = nextEmail();
    const cookie = sessionCookie(await register(email));
    await post('/auth/mfa/enroll', { password: PASSWORD }, cookie);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await post('/auth/mfa/confirm', { code: '000000' }, cookie);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: { code: 'INVALID_CODE', details: { attemptsRemaining: 5 - attempt } },
      });
    }

    const fifth = await post('/auth/mfa/confirm', { code: '000000' }, cookie);
    expect(fifth.json()).toMatchObject({ error: { details: { enrollmentDiscarded: true } } });

    const userId = await userIdFor(email);
    expect(await ctx.db.select().from(mfaTotp).where(eq(mfaTotp.userId, userId))).toHaveLength(0);

    // With the row gone, confirming again is "there is nothing to confirm", not "wrong code".
    const after = await post('/auth/mfa/confirm', { code: '000000' }, cookie);
    expect(after.statusCode).toBe(404);
    expect(after.json()).toMatchObject({ error: { code: 'NO_PENDING_ENROLLMENT' } });
  });

  it('409s when MFA is already on', async () => {
    const { cookie } = await enrolledUser();
    const res = await post('/auth/mfa/enroll', { password: PASSWORD }, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'MFA_ALREADY_ENABLED' } });
  });
});

describe('login step 2', () => {
  it('issues a pending session that guarded routes refuse', async () => {
    const { email } = await enrolledUser();
    const cookie = await pendingSession(email);

    const guarded = await get('/auth/sessions', cookie);
    expect(guarded.statusCode).toBe(401);
    // Distinct from UNAUTHENTICATED: the SPA routes this to /login/mfa, not /login.
    expect(guarded.json()).toMatchObject({ error: { code: 'MFA_REQUIRED' } });

    // The three routes a pending session may still reach.
    const me = await get('/auth/me', cookie);
    expect(me.statusCode).toBe(200);
    expect(me.json().session.mfaVerified).toBe(false);
    expect(me.json().user.mfaEnabled).toBe(true);
    expect(me.json().remainingBackupCodes).toBe(10);
  });

  it('upgrades the session with a computed TOTP', async () => {
    const { email, secret } = await enrolledUser();
    const cookie = await pendingSession(email);

    const before = await get('/auth/me', cookie);
    const pendingExpiry = Date.parse(before.json().session.expiresAt);

    const res = await post('/auth/mfa/verify', { code: freshCode(secret) }, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', user: { email, mfaEnabled: true } });
    expect(res.json().usedBackupCode).toBeUndefined();

    const after = await get('/auth/me', cookie);
    expect(after.json().session.mfaVerified).toBe(true);
    // 10 minutes becomes 7 days.
    const upgradedExpiry = Date.parse(after.json().session.expiresAt);
    expect(upgradedExpiry).toBeGreaterThan(pendingExpiry);
    expect(upgradedExpiry - clock).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);

    // And the guarded route it was refused from now answers.
    expect((await get('/auth/sessions', cookie)).statusCode).toBe(200);
    expect(await eventTypes(await userIdFor(email))).toContain('mfa_success');
  });

  it('accepts codes from ±1 step and refuses one from −2', async () => {
    const { email, secret } = await enrolledUser();

    advance(STEP_MS);
    // Two steps in the past: inside nobody's idea of clock skew, outside the window.
    const stale = codeAt(secret, -2);
    const staleRes = await post('/auth/mfa/verify', { code: stale }, await pendingSession(email));
    expect(staleRes.statusCode).toBe(401);
    expect(staleRes.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });

    // The next step's code is accepted (the user's phone is a little fast).
    const ahead = codeAt(secret, +1);
    const aheadRes = await post('/auth/mfa/verify', { code: ahead }, await pendingSession(email));
    expect(aheadRes.statusCode).toBe(200);
  });

  it('rejects a replay of a code that already worked', async () => {
    const { email, secret } = await enrolledUser();
    const code = freshCode(secret);

    const first = await post('/auth/mfa/verify', { code }, await pendingSession(email));
    expect(first.statusCode).toBe(200);

    // Same code, same 30-second step, a brand-new pending session: the only thing standing
    // between an attacker who saw those six digits and the account is `last_used_step`.
    const replay = await post('/auth/mfa/verify', { code }, await pendingSession(email));
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({
      error: { code: 'INVALID_CODE', message: /already been used/ },
    });

    const events = await eventTypes(await userIdFor(email));
    expect(events).toContain('mfa_failed');
  });

  it('accepts a backup code once, reports the remaining count, and refuses it twice', async () => {
    const { email, backupCodes } = await enrolledUser();
    const code = backupCodes[0] as string;

    const first = await post('/auth/mfa/verify', { code }, await pendingSession(email));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'ok',
      usedBackupCode: true,
      remainingBackupCodes: 9,
    });

    const second = await post('/auth/mfa/verify', { code }, await pendingSession(email));
    expect(second.statusCode).toBe(401);
    expect(second.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });

    // Another code from the same set still works, and the count keeps falling.
    const third = await post(
      '/auth/mfa/verify',
      { code: (backupCodes[1] as string).toUpperCase() },
      await pendingSession(email),
    );
    expect(third.json().remainingBackupCodes).toBe(8);

    const userId = await userIdFor(email);
    expect(await eventTypes(userId)).toContain('backup_code_used');
    const used = await ctx.db
      .select()
      .from(mfaBackupCodes)
      .where(and(eq(mfaBackupCodes.userId, userId)));
    expect(used.filter((row) => row.usedAt !== null)).toHaveLength(2);
  });

  it('rejects input that is neither a code nor a backup code with 400', async () => {
    const { email } = await enrolledUser();
    const res = await post('/auth/mfa/verify', { code: 'nope' }, await pendingSession(email));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });
  });

  it('revokes the pending session and 429s after five failures', async () => {
    const { email } = await enrolledUser();
    const cookie = await pendingSession(email);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await post('/auth/mfa/verify', { code: '000000' }, cookie);
      expect(res.statusCode).toBe(401);
    }

    const sixth = await post('/auth/mfa/verify', { code: '000000' }, cookie);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });

    // The session is gone, so even the correct code cannot save it — the user has to
    // redo the password step, which has rate limits of its own.
    const after = await get('/auth/me', cookie);
    expect(after.statusCode).toBe(401);

    const userId = await userIdFor(email);
    const live = await ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId)));
    expect(live.every((row) => row.revokedAt !== null || row.mfaVerifiedAt !== null)).toBe(true);
  });

  it('refuses a full session: verify is for the pending state only', async () => {
    const { cookie } = await enrolledUser();
    const res = await post('/auth/mfa/verify', { code: '000000' }, cookie);
    expect(res.statusCode).toBe(409);
  });
});

describe('backup code regeneration', () => {
  it('replaces the whole set and invalidates the old one', async () => {
    const { email, secret, backupCodes } = await enrolledUser();

    // Sign in fully *first*: `verifiedCookie` itself spends a step, so a code minted
    // before it would be a replay by the time the request arrives.
    const cookie = await verifiedCookie(email, secret);

    const res = await post(
      '/auth/mfa/backup-codes/regenerate',
      { password: PASSWORD, code: freshCode(secret) },
      cookie,
    );
    expect(res.statusCode).toBe(200);

    const fresh: string[] = res.json().backupCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh.filter((code) => backupCodes.includes(code))).toEqual([]);

    // An old code is now worthless...
    const old = await post(
      '/auth/mfa/verify',
      { code: backupCodes[0] as string },
      await pendingSession(email),
    );
    expect(old.statusCode).toBe(401);

    // ...and a new one works.
    const current = await post(
      '/auth/mfa/verify',
      { code: fresh[0] as string },
      await pendingSession(email),
    );
    expect(current.statusCode).toBe(200);
    expect(current.json().remainingBackupCodes).toBe(9);

    expect(await eventTypes(await userIdFor(email))).toContain('backup_codes_regenerated');
  });

  it('needs both the password and a current code', async () => {
    const { email, secret } = await enrolledUser();
    const cookie = await verifiedCookie(email, secret);

    const badPassword = await post(
      '/auth/mfa/backup-codes/regenerate',
      { password: 'wrong', code: freshCode(secret) },
      cookie,
    );
    expect(badPassword.statusCode).toBe(403);

    const badCode = await post(
      '/auth/mfa/backup-codes/regenerate',
      { password: PASSWORD, code: '000000' },
      cookie,
    );
    expect(badCode.statusCode).toBe(403);
  });
});

describe('disable', () => {
  it('turns MFA off and lets a plain login through again', async () => {
    const { email, secret } = await enrolledUser();
    const cookie = await verifiedCookie(email, secret);

    const res = await post(
      '/auth/mfa/disable',
      { password: PASSWORD, code: freshCode(secret) },
      cookie,
    );
    expect(res.statusCode).toBe(204);

    const userId = await userIdFor(email);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(user?.mfaEnabled).toBe(false);
    expect(await ctx.db.select().from(mfaTotp).where(eq(mfaTotp.userId, userId))).toHaveLength(0);
    expect(
      await ctx.db.select().from(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId)),
    ).toHaveLength(0);

    // One-step login, no challenge.
    const again = await login(email);
    expect(again.json()).toMatchObject({ status: 'ok', user: { mfaEnabled: false } });
    expect((await get('/auth/me', sessionCookie(again))).json().remainingBackupCodes).toBeNull();

    expect(await eventTypes(userId)).toContain('mfa_disabled');
  });

  it('refuses without a current code', async () => {
    const { email, secret } = await enrolledUser();
    const cookie = await verifiedCookie(email, secret);

    const res = await post('/auth/mfa/disable', { password: PASSWORD, code: '000000' }, cookie);
    expect(res.statusCode).toBe(403);

    const [user] = await ctx.db.select().from(users).where(eq(users.email, email));
    expect(user?.mfaEnabled).toBe(true);
  });

  it('409s when MFA was never enabled', async () => {
    const cookie = sessionCookie(await register(nextEmail()));
    const res = await post('/auth/mfa/disable', { password: PASSWORD, code: '000000' }, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'MFA_NOT_ENABLED' } });
  });
});

describe('the audit trail', () => {
  it('records the whole lifecycle in auth_events', async () => {
    const { email, secret, backupCodes } = await enrolledUser();
    const userId = await userIdFor(email);

    // A failure, a backup-code login, a TOTP login, a regeneration and a disable.
    await post('/auth/mfa/verify', { code: '000000' }, await pendingSession(email));
    await post('/auth/mfa/verify', { code: backupCodes[0] as string }, await pendingSession(email));
    const cookie = await verifiedCookie(email, secret);
    await post(
      '/auth/mfa/backup-codes/regenerate',
      { password: PASSWORD, code: freshCode(secret) },
      cookie,
    );
    await post('/auth/mfa/disable', { password: PASSWORD, code: freshCode(secret) }, cookie);

    const types = new Set(await eventTypes(userId));
    for (const expected of [
      'register',
      'mfa_challenge', // issued by both enrollment and the login challenge
      'mfa_enrolled',
      'mfa_failed',
      'mfa_success',
      'backup_code_used',
      'backup_codes_regenerated',
      'mfa_disabled',
    ]) {
      expect(types).toContain(expected);
    }

    // The rule from docs/02-schema.md: metadata classifies, it never carries the secret.
    const rows = await ctx.db
      .select({ metadata: authEvents.metadata })
      .from(authEvents)
      .where(eq(authEvents.userId, userId));
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain(PASSWORD);
    for (const code of backupCodes) expect(serialised).not.toContain(code);
  });
});

/** Password step plus second factor: the cookie a fully signed-in browser would hold. */
async function verifiedCookie(email: string, secret: string): Promise<string> {
  const cookie = await pendingSession(email);
  const res = await post('/auth/mfa/verify', { code: freshCode(secret) }, cookie);
  expect(res.statusCode).toBe(200);
  return cookie;
}
