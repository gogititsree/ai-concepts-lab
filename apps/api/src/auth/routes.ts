import {
  LoginRequestSchema,
  LoginResponseSchema,
  MeResponseSchema,
  PasswordChangeRequestSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  SessionIdParamSchema,
  SessionListResponseSchema,
  SESSION_ID_PREFIX_LENGTH,
  type LoginResponse,
  type PublicUser,
} from '@lab/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { users } from '../db/schema.js';
import {
  AppError,
  invalidCredentials,
  accountLocked,
  notFound,
  rateLimited,
} from '../lib/errors.js';
import { loginRouteRateLimit, registerRouteRateLimit } from '../plugins/rate-limit.js';
import { clearSessionCookie, setSessionCookie } from './cookies.js';
import { recordAuthEvent, requestOrigin } from './events.js';
import { allowPendingSession, authContext, requireFullSession } from './guards.js';
import {
  clearFailedLogins,
  isLocked,
  lockRetryAfterSeconds,
  recordFailedLogin,
} from './lockout.js';
import { hashPassword, needsRehash, verifyDummyPassword, verifyPassword } from './password.js';
import {
  createSession,
  findSessionIdByPrefix,
  listActiveSessions,
  revokeOtherSessions,
  revokeSession,
  sessionIdHex,
  type UserRow,
} from './session.js';

/**
 * `/api/v1/auth` — register, login, logout, me, password, sessions.
 *
 * The MFA half of the surface (`/auth/mfa/*`) arrives in M6. What M5 already implements
 * is the *state machine* those routes plug into: sessions carry `mfa_verified_at`, the
 * login handler has both branches, and the guard enforces `MFA_REQUIRED`. Today
 * `users.mfa_enabled` is always false, so only the happy path is reachable.
 */

/**
 * The only way a user row becomes JSON. `passwordHash`, `failedLoginCount` and
 * `lockedUntil` are simply not in the returned object — and the response schema would
 * strip them even if they were.
 */
export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    mfaEnabled: user.mfaEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * Drizzle wraps driver errors in a `DrizzleQueryError` and hangs the original off
 * `cause`, so the SQLSTATE can be one or two levels down. Walking the chain is more
 * robust than string-matching the message, which is localised and version-dependent.
 */
function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 3) return false;
  if ((error as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
  return isUniqueViolation((error as { cause?: unknown }).cause, depth + 1);
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------------------------ register ----

  routes.post(
    '/auth/register',
    {
      config: { rateLimit: registerRouteRateLimit },
      schema: { body: RegisterRequestSchema, response: { 201: RegisterResponseSchema } },
    },
    async (request, reply) => {
      const { email, password, displayName } = request.body;
      const origin = requestOrigin(request);

      const passwordHash = await hashPassword(password);

      let user: UserRow;
      try {
        const [created] = await app.db
          .insert(users)
          .values({ email, passwordHash, displayName })
          .returning();
        if (!created) throw new Error('Insert returned no row');
        user = created;
      } catch (error) {
        // `docs/03-auth-mfa.md` picks a plain 409 over the "if this email is new, an
        // account was created" dance: this is a solo learning app, register already
        // leaks existence through any UI, and a truthful error is far easier to explain.
        if (isUniqueViolation(error)) {
          throw new AppError(409, 'EMAIL_TAKEN', 'An account with that email already exists');
        }
        throw error;
      }

      // `mfaVerified: true` because nobody has MFA yet. M6 does not change this line —
      // registration always produces a full session; it is *login* that can be pending.
      const { token } = await createSession(app.db, {
        userId: user.id,
        mfaVerified: true,
        ip: origin.ip,
        userAgent: origin.userAgent,
      });
      setSessionCookie(reply, token, app.config);
      await recordAuthEvent(app.db, { userId: user.id, eventType: 'register', ...origin });

      return reply.code(201).send({ user: toPublicUser(user) });
    },
  );

  // --------------------------------------------------------------------- login ----

  routes.post(
    '/auth/login',
    {
      // Per-IP limit. The per-email limit is enforced inside the handler, because
      // @fastify/rate-limit supports a single key per route and the email only exists
      // once the body has been parsed.
      config: { rateLimit: loginRouteRateLimit },
      schema: { body: LoginRequestSchema, response: { 200: LoginResponseSchema } },
    },
    async (request, reply): Promise<LoginResponse> => {
      const { email, password } = request.body;
      const origin = requestOrigin(request);
      const emailKey = email.toLowerCase();

      const emailVerdict = app.loginEmailLimiter?.hit(emailKey);
      if (emailVerdict && !emailVerdict.allowed) {
        await recordAuthEvent(app.db, {
          eventType: 'login_failed',
          ...origin,
          metadata: { reason: 'rate_limited_email' },
        });
        throw rateLimited(`Too many login attempts, retry in ${emailVerdict.retryAfterSeconds}s`);
      }

      const [user] = await app.db.select().from(users).where(eq(users.email, emailKey)).limit(1);

      if (!user) {
        // Burn the same CPU a real argon2 verify would, so response time does not reveal
        // whether the address is registered.
        await verifyDummyPassword(password);
        await recordAuthEvent(app.db, {
          eventType: 'login_failed',
          ...origin,
          metadata: { reason: 'unknown_email' },
        });
        throw invalidCredentials();
      }

      if (isLocked(user)) {
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'login_failed',
          ...origin,
          metadata: { reason: 'locked' },
        });
        throw accountLocked(lockRetryAfterSeconds(user));
      }

      const ok = await verifyPassword(user.passwordHash, password);
      if (!ok) {
        const result = await recordFailedLogin(app.db, user);
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'login_failed',
          ...origin,
          metadata: { reason: 'bad_password', failedLoginCount: result.failedLoginCount },
        });
        if (result.justLocked) {
          await recordAuthEvent(app.db, {
            userId: user.id,
            eventType: 'lockout',
            ...origin,
            metadata: { until: result.lockedUntil?.toISOString() ?? null },
          });
        }
        // Identical code, message and status to the unknown-email branch above.
        throw invalidCredentials();
      }

      await clearFailedLogins(app.db, user);

      // The parameters in ARGON2_OPTIONS may have been raised since this hash was made.
      // Right after a successful verify is the only moment the plaintext exists, so it is
      // the only moment a silent upgrade is possible.
      if (needsRehash(user.passwordHash)) {
        const upgraded = await hashPassword(password);
        await app.db
          .update(users)
          .set({ passwordHash: upgraded, updatedAt: new Date() })
          .where(eq(users.id, user.id));
      }

      const { token } = await createSession(app.db, {
        userId: user.id,
        // MFA on → a *pending* session: 10 minutes, `mfa_verified_at IS NULL`, and every
        // guarded route answers MFA_REQUIRED until `/auth/mfa/verify` upgrades it.
        mfaVerified: !user.mfaEnabled,
        ip: origin.ip,
        userAgent: origin.userAgent,
      });
      setSessionCookie(reply, token, app.config);

      if (user.mfaEnabled) {
        await recordAuthEvent(app.db, { userId: user.id, eventType: 'mfa_challenge', ...origin });
        return { status: 'mfa_required' };
      }

      // A correct password clears this email's budget so a legitimate user who fat-fingers
      // their password nine times is not throttled for the next 15 minutes.
      app.loginEmailLimiter?.reset(emailKey);
      await recordAuthEvent(app.db, { userId: user.id, eventType: 'login_success', ...origin });
      return { status: 'ok', user: toPublicUser(user) };
    },
  );

  // -------------------------------------------------------------------- logout ----

  routes.post(
    '/auth/logout',
    // Pending sessions may log out: being stuck between the two login steps must not
    // leave a user unable to get rid of the cookie.
    { preHandler: allowPendingSession },
    async (request, reply) => {
      const { user, session } = authContext(request);
      await revokeSession(app.db, session.id);
      clearSessionCookie(reply, app.config);
      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'logout',
        ...requestOrigin(request),
      });
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------------ me ----

  routes.get(
    '/auth/me',
    {
      preHandler: allowPendingSession,
      schema: { response: { 200: MeResponseSchema } },
    },
    async (request) => {
      const { user, session } = authContext(request);
      return {
        user: toPublicUser(user),
        session: {
          mfaVerified: session.mfaVerifiedAt !== null,
          expiresAt: session.expiresAt.toISOString(),
        },
      };
    },
  );

  // ----------------------------------------------------------- change password ----

  routes.patch(
    '/auth/password',
    {
      preHandler: requireFullSession,
      schema: { body: PasswordChangeRequestSchema },
    },
    async (request, reply) => {
      const { user, session } = authContext(request);
      const { currentPassword, newPassword } = request.body;

      const ok = await verifyPassword(user.passwordHash, currentPassword);
      if (!ok) {
        // 403, not 401: the session is perfectly valid, so a 401 would make the SPA log
        // the user out over a typo. What failed is the step-up, not the authentication.
        throw new AppError(403, 'INVALID_CREDENTIALS', 'Current password is incorrect');
      }

      const passwordHash = await hashPassword(newPassword);
      await app.db
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      // The whole point of changing a password after a suspected compromise: every other
      // device is logged out, and only the caller — who just proved knowledge of the old
      // password — keeps their session.
      const revoked = await revokeOtherSessions(app.db, user.id, session.id);
      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'password_changed',
        ...requestOrigin(request),
        metadata: { revokedSessions: revoked },
      });

      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------ sessions ----

  routes.get(
    '/auth/sessions',
    {
      preHandler: requireFullSession,
      schema: { response: { 200: SessionListResponseSchema } },
    },
    async (request) => {
      const { user, session } = authContext(request);
      const rows = await listActiveSessions(app.db, user.id);
      const currentHex = sessionIdHex(session.id);
      return {
        sessions: rows.map((row) => {
          const hex = sessionIdHex(row.id);
          return {
            id: hex.slice(0, SESSION_ID_PREFIX_LENGTH),
            createdAt: row.createdAt.toISOString(),
            lastSeenAt: row.lastSeenAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            ip: row.ip,
            userAgent: row.userAgent,
            current: hex === currentHex,
          };
        }),
      };
    },
  );

  routes.delete(
    '/auth/sessions/:id',
    {
      preHandler: requireFullSession,
      schema: { params: SessionIdParamSchema },
    },
    async (request, reply) => {
      const { user, session } = authContext(request);
      // Resolution is scoped to the caller's own sessions, so guessing another user's
      // prefix reveals nothing and revokes nothing — it is a 404 either way.
      const target = await findSessionIdByPrefix(app.db, user.id, request.params.id);
      if (!target) throw notFound('No such session');

      await revokeSession(app.db, target);
      const isSelf = target.equals(session.id);
      if (isSelf) clearSessionCookie(reply, app.config);

      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'session_revoked',
        ...requestOrigin(request),
        metadata: {
          sessionId: sessionIdHex(target).slice(0, SESSION_ID_PREFIX_LENGTH),
          self: isSelf,
        },
      });

      return reply.code(204).send();
    },
  );
};
