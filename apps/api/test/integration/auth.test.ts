import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { ABSOLUTE_TIMEOUT_MS } from '../../src/auth/session.js';
import { cleanupExpiredSessions } from '../../src/auth/housekeeping.js';
import { loadConfig, type Config } from '../../src/config.js';
import { authEvents, sessions, users } from '../../src/db/schema.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * The auth surface against a real Postgres: every route, the guard, the audit trail and
 * the two rate limits. `app.inject()` drives the whole stack (hooks, validation,
 * serialisation) without a socket, so these are fast enough to be the *default* place a
 * behaviour is pinned down — the unit suites only cover what is genuinely pure.
 */

const APP_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';

/** Every state-changing request the SPA makes carries this. */
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };

let ctx: TestDb;
let app: FastifyInstance;
let config: Config;

/**
 * The exact `sid=...` pair a browser would send back, taken from the raw `Set-Cookie`
 * rather than from the parsed value: the signed token is percent-encoded on the wire, and
 * re-encoding a decoded value by hand is how cookie round-trip bugs get written.
 */
function sessionCookie(res: InjectResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const sid = list.find((entry) => entry.startsWith('sid='));
  if (!sid) throw new Error(`No sid cookie in response: ${JSON.stringify(raw)}`);
  return sid.split(';')[0] as string;
}

function setCookieHeader(res: InjectResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  return list.find((entry) => entry.startsWith('sid=')) ?? '';
}

const register = (email: string, password = PASSWORD, displayName = 'Test User') =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: WRITE_HEADERS,
    payload: { email, password, displayName },
  });

const login = (email: string, password: string, instance: FastifyInstance = app) =>
  instance.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: WRITE_HEADERS,
    payload: { email, password },
  });

const me = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });

let emailCounter = 0;
const nextEmail = (): string => `user${(emailCounter += 1)}@example.test`;

beforeAll(async () => {
  ctx = await setupTestDb({ seed: false });
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: ctx.url,
    SESSION_SECRET: 'integration-test-session-secret-0123456789',
    APP_ORIGIN,
  });
  app = await buildApp({
    config,
    db: ctx.db,
    // Off for the bulk of the suite: 5 registrations per hour per IP would otherwise fail
    // the sixth test for reasons unrelated to what it asserts. The limits get their own
    // app at the bottom of this file.
    rateLimits: false,
    checks: { checkDb: async () => ({ ok: true }) },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await ctx?.teardown();
});

describe('register → me → logout → login', () => {
  it('registers a user, returns 201 and a session cookie', async () => {
    const email = nextEmail();
    const res = await register(email);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toEqual({
      id: expect.any(String),
      email,
      displayName: 'Test User',
      mfaEnabled: false,
      createdAt: expect.any(String),
    });
    // Structural, not incidental: the response schema has no such field, so it could not
    // be sent even if a handler tried.
    expect(Object.keys(body.user)).not.toContain('passwordHash');
    expect(res.payload).not.toContain('argon2');
  });

  it('sets the documented cookie flags', async () => {
    const res = await register(nextEmail());
    const header = setCookieHeader(res);

    expect(header).toMatch(/^sid=/);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${ABSOLUTE_TIMEOUT_MS / 1000}`);
    // COOKIE_SECURE defaults to false outside production; a Secure cookie over
    // http://localhost would be dropped by the browser.
    expect(header).not.toContain('Secure');
  });

  it('rejects a duplicate email with 409 EMAIL_TAKEN', async () => {
    const email = nextEmail();
    await register(email);
    const second = await register(email);

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'EMAIL_TAKEN' } });
  });

  it('treats email as case-insensitive (citext)', async () => {
    const email = nextEmail();
    await register(email);

    const dupe = await register(email.toUpperCase());
    expect(dupe.statusCode).toBe(409);

    const upperLogin = await login(email.toUpperCase(), PASSWORD);
    expect(upperLogin.statusCode).toBe(200);
  });

  it('walks the whole happy path', async () => {
    const email = nextEmail();

    const registered = await register(email);
    const cookie = sessionCookie(registered);

    const afterRegister = await me(cookie);
    expect(afterRegister.statusCode).toBe(200);
    expect(afterRegister.json()).toMatchObject({
      user: { email },
      session: { mfaVerified: true, expiresAt: expect.any(String) },
    });

    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...WRITE_HEADERS, cookie },
    });
    expect(loggedOut.statusCode).toBe(204);
    expect(loggedOut.payload).toBe('');
    // The clearing Set-Cookie must repeat Path and SameSite, or the browser keeps the old
    // cookie alongside the new empty one.
    expect(setCookieHeader(loggedOut)).toContain('Path=/');

    // The cookie is now worthless even if the client hangs on to it.
    const afterLogout = await me(cookie);
    expect(afterLogout.statusCode).toBe(401);
    expect(afterLogout.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    const loggedIn = await login(email, PASSWORD);
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json()).toEqual({ status: 'ok', user: expect.objectContaining({ email }) });

    const afterLogin = await me(sessionCookie(loggedIn));
    expect(afterLogin.statusCode).toBe(200);
  });
});

describe('failed logins', () => {
  it('answers a wrong password and an unknown email identically', async () => {
    const email = nextEmail();
    await register(email);

    const startWrong = performance.now();
    const wrongPassword = await login(email, 'definitely not the password');
    const wrongPasswordMs = performance.now() - startWrong;

    const startUnknown = performance.now();
    const unknownEmail = await login('nobody-here@example.test', PASSWORD);
    const unknownEmailMs = performance.now() - startUnknown;

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Byte-for-byte identical: no "unknown user" vs "bad password" distinction to mine.
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
    expect(wrongPassword.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
    // Same *time class*: the unknown-email branch verifies against a dummy hash, so both
    // pay for one argon2 verification. Asserting a floor (rather than a ratio) keeps this
    // from flaking on a busy CI runner while still catching a fast-path regression.
    expect(unknownEmailMs).toBeGreaterThan(20);
    expect(wrongPasswordMs).toBeGreaterThan(20);
  });

  it('never sets a cookie on a failed login', async () => {
    const res = await login('nobody-here@example.test', PASSWORD);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('locks the account after 10 failures and unlocks when the lock expires', async () => {
    const email = nextEmail();
    const registered = await register(email);
    const userId = registered.json().user.id as string;

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const res = await login(email, `wrong-${attempt}`);
      expect(res.statusCode).toBe(401);
    }

    const [locked] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(locked?.failedLoginCount).toBe(10);
    expect(locked?.lockedUntil).toBeInstanceOf(Date);

    // Even the *correct* password is refused while the lock stands — that is the whole
    // point: an online guessing attack cannot be outrun by getting lucky on attempt 11.
    const duringLock = await login(email, PASSWORD);
    expect(duringLock.statusCode).toBe(423);
    expect(duringLock.json()).toMatchObject({ error: { code: 'LOCKED' } });

    // Rather than waiting 15 minutes (or faking a clock the database does not share),
    // move the deadline into the past: the lock is data, not a timer.
    await ctx.db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, userId));

    const afterUnlock = await login(email, PASSWORD);
    expect(afterUnlock.statusCode).toBe(200);

    // A success resets the counter, so the next ten mistakes start from zero.
    const [unlocked] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(unlocked?.failedLoginCount).toBe(0);
    expect(unlocked?.lockedUntil).toBeNull();
  }, 60_000);
});

describe('CSRF protection', () => {
  it('403s a POST without X-Requested-With', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@b.test', password: PASSWORD },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'CSRF_REJECTED', details: { reason: 'missing_header' } },
    });
  });

  it('403s a POST from a foreign Origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: 'https://evil.example' },
      payload: { email: 'a@b.test', password: PASSWORD },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'CSRF_REJECTED', details: { reason: 'origin_mismatch' } },
    });
  });

  it('leaves GET /health alone', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('session management', () => {
  it('lists active sessions and flags the current one', async () => {
    const email = nextEmail();
    const first = await register(email);
    const second = await login(email, PASSWORD);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: sessionCookie(second) },
    });

    expect(res.statusCode).toBe(200);
    const list = res.json().sessions as Array<{ id: string; current: boolean; ip: string | null }>;
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    // The id is a prefix of sha256(token): enough to name a session, useless as one.
    for (const session of list) expect(session.id).toMatch(/^[0-9a-f]{8}$/);
    expect(list[0]?.ip).toBe('127.0.0.1');
    // The full 64-character id never leaves the database.
    expect(res.payload).not.toMatch(/[0-9a-f]{64}/);
    expect(first.statusCode).toBe(201);
  });

  it('revokes another session by its id prefix', async () => {
    const email = nextEmail();
    const keep = sessionCookie(await register(email));
    const doomed = await login(email, PASSWORD);
    const doomedCookie = sessionCookie(doomed);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: doomedCookie },
    });
    const target = (listed.json().sessions as Array<{ id: string; current: boolean }>).find(
      (s) => s.current,
    );

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${target?.id}`,
      headers: { ...WRITE_HEADERS, cookie: keep },
    });
    expect(deleted.statusCode).toBe(204);

    expect((await me(doomedCookie)).statusCode).toBe(401);
    expect((await me(keep)).statusCode).toBe(200);
  });

  it('404s an unknown session id instead of revealing anything', async () => {
    const cookie = sessionCookie(await register(nextEmail()));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/deadbeef',
      headers: { ...WRITE_HEADERS, cookie },
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed session id at the schema boundary', async () => {
    const cookie = sessionCookie(await register(nextEmail()));

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/not-hex!',
      headers: { ...WRITE_HEADERS, cookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});

describe('password change', () => {
  it('revokes every other session and leaves the caller logged in', async () => {
    const email = nextEmail();
    const keep = sessionCookie(await register(email));
    const other = sessionCookie(await login(email, PASSWORD));
    const newPassword = 'a completely different passphrase';

    const changed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { ...WRITE_HEADERS, cookie: keep },
      payload: { currentPassword: PASSWORD, newPassword },
    });
    expect(changed.statusCode).toBe(204);

    // The point of the flow: the device you are holding stays signed in, everything else
    // is cut off.
    expect((await me(keep)).statusCode).toBe(200);
    expect((await me(other)).statusCode).toBe(401);

    expect((await login(email, PASSWORD)).statusCode).toBe(401);
    expect((await login(email, newPassword)).statusCode).toBe(200);
  }, 60_000);

  it('403s a wrong current password without logging the caller out', async () => {
    const cookie = sessionCookie(await register(nextEmail()));

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { ...WRITE_HEADERS, cookie },
      payload: { currentPassword: 'not it', newPassword: 'another good long passphrase' },
    });

    // 403 rather than 401: the session is fine, the step-up is what failed. A 401 would
    // make the SPA sign the user out over a typo.
    expect(res.statusCode).toBe(403);
    expect((await me(cookie)).statusCode).toBe(200);
  });

  it('rejects a new password that is on the common list', async () => {
    const cookie = sessionCookie(await register(nextEmail()));

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { ...WRITE_HEADERS, cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'password1234' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});

/**
 * M6's contract, proven in M5. Nothing in the API can set `mfa_enabled` yet, so the state
 * is created directly in the database — which is exactly the point: the guard's behaviour
 * is a property of the schema, not of the (not yet written) MFA routes.
 */
describe('the MFA_REQUIRED contract', () => {
  it('blocks full-session routes but still allows /me and /logout', async () => {
    const email = nextEmail();
    const registered = await register(email);
    const cookie = sessionCookie(registered);
    const userId = registered.json().user.id as string;

    await ctx.db.update(users).set({ mfaEnabled: true }).where(eq(users.id, userId));
    await ctx.db.update(sessions).set({ mfaVerifiedAt: null }).where(eq(sessions.userId, userId));

    const guarded = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie },
    });
    expect(guarded.statusCode).toBe(401);
    // A distinct code, because the SPA must route here to /login/mfa, not to /login.
    expect(guarded.json()).toMatchObject({ error: { code: 'MFA_REQUIRED' } });

    const pendingMe = await me(cookie);
    expect(pendingMe.statusCode).toBe(200);
    expect(pendingMe.json().session.mfaVerified).toBe(false);
    expect(pendingMe.json().user.mfaEnabled).toBe(true);

    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...WRITE_HEADERS, cookie },
    });
    expect(loggedOut.statusCode).toBe(204);
  });

  it('issues a pending session from login when MFA is enabled', async () => {
    const email = nextEmail();
    const registered = await register(email);
    await ctx.db
      .update(users)
      .set({ mfaEnabled: true })
      .where(eq(users.id, registered.json().user.id as string));

    const res = await login(email, PASSWORD);

    expect(res.statusCode).toBe(200);
    // The branch that M6 fills in: the password was right, the cookie is set, and the
    // session is pending until /auth/mfa/verify upgrades it.
    expect(res.json()).toEqual({ status: 'mfa_required' });
    expect(res.headers['set-cookie']).toBeTruthy();

    const pending = await me(sessionCookie(res));
    expect(pending.json().session.mfaVerified).toBe(false);
  });
});

describe('the audit trail', () => {
  it('records register, login_success, login_failed, lockout and logout', async () => {
    const email = nextEmail();
    const registered = await register(email);
    const userId = registered.json().user.id as string;
    const cookie = sessionCookie(registered);

    await login(email, PASSWORD);
    await login(email, 'wrong');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...WRITE_HEADERS, cookie },
    });

    const rows = await ctx.db.select().from(authEvents).where(eq(authEvents.userId, userId));
    const types = rows.map((row) => row.eventType);

    expect(types).toContain('register');
    expect(types).toContain('login_success');
    expect(types).toContain('login_failed');
    expect(types).toContain('logout');
    // Provenance is recorded, secrets never are.
    expect(rows.every((row) => row.ip === '127.0.0.1')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  }, 60_000);

  it('records a login_failed with a null user for an unknown email', async () => {
    await login('ghost@example.test', PASSWORD);

    const rows = await ctx.db.select().from(authEvents);
    const orphan = rows.find(
      (row) =>
        row.userId === null && (row.metadata as { reason?: string }).reason === 'unknown_email',
    );
    expect(orphan).toBeDefined();
  });

  it('records a lockout event on the tenth failure', async () => {
    const email = nextEmail();
    const userId = (await register(email)).json().user.id as string;
    for (let attempt = 1; attempt <= 10; attempt += 1) await login(email, `wrong-${attempt}`);

    const rows = await ctx.db.select().from(authEvents).where(eq(authEvents.userId, userId));
    expect(rows.filter((row) => row.eventType === 'lockout')).toHaveLength(1);
  }, 60_000);
});

describe('housekeeping', () => {
  it('deletes only sessions well past their expiry', async () => {
    const email = nextEmail();
    const registered = await register(email);
    const userId = registered.json().user.id as string;
    const cookie = sessionCookie(registered);

    // Long enough ago to be outside the one-week forensic grace period.
    await ctx.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })
      .where(eq(sessions.userId, userId));

    const before = await ctx.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(before).toHaveLength(1);

    const result = await cleanupExpiredSessions(ctx.db);
    expect(result.sessionsDeleted).toBeGreaterThanOrEqual(1);

    const after = await ctx.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(after).toHaveLength(0);
    expect((await me(cookie)).statusCode).toBe(401);
  });
});

describe('rate limiting', () => {
  it('429s the eleventh login attempt from one IP', async () => {
    const email = nextEmail();
    await register(email);

    // A second app over the same database, this time with the limits switched on.
    const limited = await buildApp({
      config,
      db: ctx.db,
      rateLimits: true,
      checks: { checkDb: async () => ({ ok: true }) },
    });
    await limited.ready();

    try {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const res = await login(email, `wrong-${attempt}`, limited);
        // 401 for a bad password; the tenth failure also locks the account, which the
        // limiter does not care about.
        expect(res.statusCode).toBe(401);
      }

      const eleventh = await login(email, `wrong-11`, limited);
      expect(eleventh.statusCode).toBe(429);
      expect(eleventh.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(eleventh.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  }, 60_000);

  it('429s the sixth registration from one IP', async () => {
    const limited = await buildApp({
      config,
      db: ctx.db,
      rateLimits: true,
      checks: { checkDb: async () => ({ ok: true }) },
    });
    await limited.ready();

    try {
      const attempt = (email: string) =>
        limited.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          headers: WRITE_HEADERS,
          payload: { email, password: PASSWORD, displayName: 'Rate Limited' },
        });

      for (let i = 1; i <= 5; i += 1) {
        expect((await attempt(nextEmail())).statusCode).toBe(201);
      }
      expect((await attempt(nextEmail())).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  }, 60_000);
});
