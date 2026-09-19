import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../lib/errors.js';

/**
 * Rate limiting, per `docs/03-auth-mfa.md`.
 *
 *   login:    10 / 15 min per IP  **and**  10 / 15 min per email
 *   register:  5 / hour per IP
 *
 * The store is in-memory. That is a conscious limitation, written down in the design doc:
 * a single instance means one process holds the counters, and a deploy resets them. A
 * Postgres-backed store is a later exercise; for a solo app the failure mode ("an
 * attacker gets a fresh 10 attempts each time I deploy") is not worth the write
 * amplification.
 */

/** Login: 10 attempts per 15 minutes. */
export const LOGIN_RATE_LIMIT = { max: 10, timeWindow: 15 * 60 * 1000 } as const;
/** Register: 5 accounts per hour from one address. */
export const REGISTER_RATE_LIMIT = { max: 5, timeWindow: 60 * 60 * 1000 } as const;

export interface LimiterVerdict {
  allowed: boolean;
  /** Attempts left in the current window (0 once blocked). */
  remaining: number;
  /** Seconds until the window rolls over. */
  retryAfterSeconds: number;
}

/**
 * A fixed-window counter keyed by an arbitrary string.
 *
 * Why hand-rolled: `@fastify/rate-limit` allows exactly one `keyGenerator` per route, and
 * the login route needs two independent limits (by IP, by email). The IP limit is the
 * plugin's job because it must run before the body is even parsed; the email limit needs
 * the parsed body, so it runs inside the handler against this map.
 *
 * Fixed windows (rather than sliding) are chosen for the same reason the design doc picks
 * an in-memory store: the worst case is 2× the nominal rate across a window boundary,
 * which changes nothing about whether an online guessing attack is feasible.
 */
export class FixedWindowLimiter {
  readonly max: number;
  readonly windowMs: number;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Records an attempt and reports whether it is allowed. */
  hit(key: string, now: number = Date.now()): LimiterVerdict {
    this.prune(now);
    const existing = this.hits.get(key);
    const window =
      existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + this.windowMs };
    window.count += 1;
    this.hits.set(key, window);

    return {
      allowed: window.count <= this.max,
      remaining: Math.max(0, this.max - window.count),
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  /** Forgets one key (a successful login) or all of them (test setup). */
  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }

  /**
   * Drops finished windows. Without this the map is an unbounded, attacker-controlled
   * allocation: every distinct email in a spray is a key that never goes away.
   */
  private prune(now: number): void {
    for (const [key, window] of this.hits) {
      if (window.resetAt <= now) this.hits.delete(key);
    }
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Per-email login limiter; see `FixedWindowLimiter`. Null when limits are disabled. */
    loginEmailLimiter: FixedWindowLimiter | null;
  }
}

/**
 * The per-route config object handed to Fastify (`{ config: { rateLimit } }`).
 * `@fastify/rate-limit` is registered with `global: false`, so a route without one of
 * these is unlimited — which is what `GET /health` needs.
 */
export const loginRouteRateLimit = {
  max: LOGIN_RATE_LIMIT.max,
  timeWindow: LOGIN_RATE_LIMIT.timeWindow,
};

export const registerRouteRateLimit = {
  max: REGISTER_RATE_LIMIT.max,
  timeWindow: REGISTER_RATE_LIMIT.timeWindow,
};

export interface RateLimitOptions {
  /**
   * Integration tests that are not *about* rate limiting build the app with this off:
   * 5 registrations per hour per IP would otherwise make the rest of the suite fail on
   * the sixth test rather than on a real defect. The suite that asserts the limit builds
   * its own app with it on.
   */
  enabled?: boolean;
}

export async function registerRateLimits(
  app: FastifyInstance,
  options: RateLimitOptions = {},
): Promise<void> {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    app.decorate('loginEmailLimiter', null);
    return;
  }

  app.decorate(
    'loginEmailLimiter',
    new FixedWindowLimiter(LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.timeWindow),
  );

  await app.register(rateLimit, {
    // Opt-in per route: a global limit would throttle the SPA's own polling and the
    // uptime monitor, neither of which is the threat being defended against.
    global: false,
    // The plugin throws whatever this returns; returning the app's own error type means
    // the 429 body matches every other error body without special-casing the handler.
    errorResponseBuilder: (_request, context) =>
      new AppError(429, 'RATE_LIMITED', `Rate limit exceeded, retry in ${context.after}`, {
        retryAfterSeconds: Math.ceil(context.ttl / 1000),
      }),
  });
}
