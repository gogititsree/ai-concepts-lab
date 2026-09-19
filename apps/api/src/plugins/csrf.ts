import type { FastifyInstance } from 'fastify';

import { AppError } from '../lib/errors.js';

/**
 * CSRF defence, layer two.
 *
 * Layer one is the cookie's `SameSite=Lax`, which already stops a cross-site form POST
 * from carrying the session. This plugin adds the two checks that do not depend on the
 * browser getting SameSite right:
 *
 *  1. **A custom request header.** `X-Requested-With: fetch` cannot be set by an HTML
 *     form or a plain `<img>`/`<script>` cross-origin request. Sending it from another
 *     origin requires XHR/fetch, which requires a successful CORS preflight, which this
 *     API does not grant in production. The attacker's page can *make* the request; it
 *     cannot make it carry this header.
 *  2. **An `Origin` check.** Browsers attach `Origin` to every non-GET request, and it is
 *     one of the headers script cannot forge. When it is present it must equal
 *     `APP_ORIGIN`. It is *not* required, because non-browser clients (curl in the
 *     README, a health prober) legitimately omit it, and demanding it would only stop
 *     the callers who were never at risk.
 *
 * Safe methods are exempt: `GET`/`HEAD` change nothing, and `OPTIONS` is the preflight
 * itself, which by definition has no header to check yet.
 */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'fetch';

/** RFC 9110 safe methods, plus the CORS preflight. */
export const CSRF_EXEMPT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfRejectionReason = 'missing_header' | 'origin_mismatch';

export type CsrfDecision =
  { allowed: true } | { allowed: false; reason: CsrfRejectionReason; message: string };

export interface CsrfInput {
  method: string;
  url: string;
  requestedWith?: string | string[] | undefined;
  origin?: string | string[] | undefined;
  referer?: string | string[] | undefined;
  appOrigin: string;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `https://app.example/path?q=1` → `https://app.example`; invalid input → null. */
function originOf(value: string | undefined): string | null {
  if (!value || value === 'null') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The decision, as a pure function, so it can be unit-tested exhaustively without a
 * server. The plugin below is a five-line adapter around it.
 */
export function evaluateCsrf(input: CsrfInput): CsrfDecision {
  if (CSRF_EXEMPT_METHODS.has(input.method.toUpperCase())) return { allowed: true };
  // Only the JSON API is protected. Static SPA assets are GETs anyway, but scoping the
  // rule to /api keeps the blast radius of this hook obvious.
  if (!input.url.startsWith('/api')) return { allowed: true };

  const requestedWith = first(input.requestedWith);
  if (requestedWith?.toLowerCase() !== CSRF_HEADER_VALUE) {
    return {
      allowed: false,
      reason: 'missing_header',
      message: `State-changing requests must send the header ${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`,
    };
  }

  // `Origin` when the browser sent one; otherwise fall back to `Referer`, which
  // docs/03-auth-mfa.md lists as the alternative. Neither present → nothing to check.
  const claimed = originOf(first(input.origin)) ?? originOf(first(input.referer));
  if (claimed !== null && claimed !== input.appOrigin) {
    return {
      allowed: false,
      reason: 'origin_mismatch',
      message: 'Request origin is not allowed',
    };
  }

  return { allowed: true };
}

/**
 * Installs the check as a global `onRequest` hook.
 *
 * Deliberately *not* a `fastify-plugin`-wrapped plugin: `fastify-plugin` is not a
 * declared dependency of this package, and a hook added inside an un-wrapped
 * `register()` would be scoped to that encapsulation context instead of the whole app.
 * Adding the hook to the root instance directly is one line and has no such trap.
 */
export function registerCsrfGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    const decision = evaluateCsrf({
      method: request.method,
      url: request.url,
      requestedWith: request.headers[CSRF_HEADER],
      origin: request.headers.origin,
      referer: request.headers.referer,
      appOrigin: app.config.APP_ORIGIN,
    });
    if (decision.allowed) return;

    request.log.warn(
      { reason: decision.reason, method: request.method, url: request.url },
      'CSRF check rejected request',
    );
    throw new AppError(403, 'CSRF_REJECTED', decision.message, { reason: decision.reason });
  });
}
