import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Config } from '../config.js';
import { ABSOLUTE_TIMEOUT_MS } from './session.js';

/**
 * The `sid` cookie: one name, one set of attributes, defined once so the login, register
 * and logout paths cannot drift apart.
 */
export const SESSION_COOKIE_NAME = 'sid';

/**
 * Why each attribute is what it is:
 *
 * - `httpOnly` — the token must be unreachable from JavaScript, so an XSS bug cannot
 *   exfiltrate a session. It is the single highest-value flag here.
 * - `secure` — config-driven (true in production). Hard-coding it would break local
 *   development: browsers silently drop `Secure` cookies on `http://localhost`, which
 *   presents as "login succeeds but every later request is 401".
 * - `sameSite: 'lax'` — blocks the cookie on cross-site POSTs (the CSRF case) while still
 *   sending it when the user follows a link into the app. `strict` would break that
 *   navigation for no extra protection here, because the `X-Requested-With` check in
 *   `plugins/csrf.ts` already covers what Lax leaves open.
 * - `path: '/'` — the SPA and the API share an origin in production.
 * - `maxAge` — the *absolute* session lifetime (30 days). Aligning it with the longest a
 *   session can possibly live means the browser stops sending a cookie the server would
 *   only reject; the server-side `expires_at` is still the authority, since a cookie's
 *   expiry is a client-side hint an attacker can ignore.
 * - `signed` — HMAC with `SESSION_SECRET`, so a forged or truncated cookie is discarded
 *   before it costs a database lookup.
 */
export function sessionCookieOptions(config: Config): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(ABSOLUTE_TIMEOUT_MS / 1000),
    signed: true,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, config: Config): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(config));
}

/**
 * Clears the cookie with the same attributes it was set with. A `Set-Cookie` whose
 * `Path` or `SameSite` differs from the original does not overwrite it, and the stale
 * cookie lives on — which is why this reuses `sessionCookieOptions` rather than passing
 * `{ path: '/' }` and hoping.
 */
export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions(config);
  reply.clearCookie(SESSION_COOKIE_NAME, options);
}

/**
 * Returns the raw session token from the request, or null when the cookie is absent or
 * its signature does not verify.
 *
 * Requires `@fastify/cookie` to be registered with `secret` set, which `buildApp` does.
 */
export function readSessionToken(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;
  return unsigned.value;
}
