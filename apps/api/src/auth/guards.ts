import type {
  FastifyBaseLogger,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';

import { mfaRequired, unauthenticated } from '../lib/errors.js';
import { clearSessionCookie, readSessionToken } from './cookies.js';
import {
  isSessionActive,
  loadSessionWithUser,
  sessionIdFromToken,
  sessionIdHex,
  touchSession,
  type SessionRow,
  type UserRow,
} from './session.js';

/**
 * The request guard from `docs/03-auth-mfa.md` → "Request guard (every protected route)".
 *
 * Declaration merging puts `request.user` / `request.session` on Fastify's own types, so
 * a handler that reads them is type-checked rather than casting `as any`. They are
 * `null` until a guard runs, which is honest: most routes in this app are public.
 */
declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    session: SessionRow | null;
  }
}

export interface AuthenticatedContext {
  user: UserRow;
  session: SessionRow;
}

/**
 * Narrowing helper for handlers behind a guard: the guard guarantees both are set, but
 * the *type* cannot know which routes have one. Calling this is one line and keeps every
 * handler free of `!`.
 */
export function authContext(request: FastifyRequest): AuthenticatedContext {
  if (!request.user || !request.session) throw unauthenticated();
  return { user: request.user, session: request.session };
}

export interface AuthGuardOptions {
  /**
   * Accept a session that has passed the password step but not the second factor.
   * Per the design doc only `/auth/mfa/verify`, `/auth/logout` and `/auth/me` do.
   */
  allowPending?: boolean;
}

/**
 * Builds the `preHandler` that turns a cookie into `request.user` + `request.session`.
 *
 * Order matters and is the doc's order:
 *   cookie → hash → row → liveness → MFA state → touch → attach.
 *
 * Note what is *not* here: CSRF. That is a global plugin (`plugins/csrf.ts`) so it also
 * protects unauthenticated state-changing routes like `POST /auth/login`, where there is
 * no session to guard.
 */
export function requireAuth(options: AuthGuardOptions = {}): preHandlerHookHandler {
  const allowPending = options.allowPending ?? false;

  return async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = readSessionToken(request);
    if (!token) throw unauthenticated('No session cookie');

    const id = sessionIdFromToken(token);
    const found = await loadSessionWithUser(request.server.db, id);
    if (!found) {
      // A cookie whose signature checked out but whose session is gone: cleaned up, or
      // the database was reset. Drop it so the browser stops re-sending it.
      clearSessionCookie(reply, request.server.config);
      throw unauthenticated('Session not found');
    }

    const { user } = found;
    let { session } = found;

    if (!isSessionActive(session)) {
      clearSessionCookie(reply, request.server.config);
      throw unauthenticated(session.revokedAt ? 'Session revoked' : 'Session expired');
    }

    // The M6 contract, implemented in M5: `mfa_enabled` is always false today, so this
    // branch is unreachable until enrollment exists — but the semantics of
    // `sessions.mfa_verified_at` are already load-bearing, and the integration suite
    // proves it by flipping the flag directly in the database.
    if (user.mfaEnabled && session.mfaVerifiedAt === null && !allowPending) {
      throw mfaRequired();
    }

    session = await touchSession(request.server.db, session);

    request.user = user;
    request.session = session;

    // Every log line for the rest of this request carries who made it. The session id is
    // truncated: a full one is the hash of a live credential and logs get shipped around.
    // `setBindings` is pino's, and Fastify's `FastifyBaseLogger` interface does not
    // declare it (it is optional in the abstraction, because a custom logger need not
    // provide it). Hence the narrow cast and the optional call.
    const logger = request.log as FastifyBaseLogger & {
      setBindings?: (bindings: Record<string, unknown>) => void;
    };
    logger.setBindings?.({
      userId: user.id,
      sessionId: sessionIdHex(session.id).slice(0, 8),
    });
  };
}

/** A fully authenticated session: password *and* (once M6 lands) second factor. */
export const requireFullSession: preHandlerHookHandler = requireAuth();

/**
 * Also accepts a pending-MFA session. Used by `/auth/logout` and `/auth/me` so a user
 * stuck between the two login steps can still see who they are and get out.
 */
export const allowPendingSession: preHandlerHookHandler = requireAuth({ allowPending: true });
