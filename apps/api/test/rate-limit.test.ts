import { describe, expect, it } from 'vitest';

import {
  FixedWindowLimiter,
  LOGIN_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
} from '../src/plugins/rate-limit.js';

/**
 * The per-email half of the login limit. The per-IP half is `@fastify/rate-limit`'s job
 * and is asserted end-to-end in `test/integration/auth.test.ts`.
 */
describe('FixedWindowLimiter', () => {
  it('allows exactly `max` attempts inside a window', () => {
    const limiter = new FixedWindowLimiter(3, 1000);

    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('a', 10).allowed).toBe(true);
    expect(limiter.hit('a', 20)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.hit('a', 30).allowed).toBe(false);
  });

  it('counts each key separately', () => {
    const limiter = new FixedWindowLimiter(1, 1000);

    expect(limiter.hit('alice@example.com', 0).allowed).toBe(true);
    expect(limiter.hit('alice@example.com', 1).allowed).toBe(false);
    // Locking out one email must not lock out everybody else.
    expect(limiter.hit('bob@example.com', 1).allowed).toBe(true);
  });

  it('starts a fresh window once the old one has elapsed', () => {
    const limiter = new FixedWindowLimiter(1, 1000);

    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('a', 999).allowed).toBe(false);
    expect(limiter.hit('a', 1001).allowed).toBe(true);
  });

  it('reports the seconds until the window rolls over', () => {
    const limiter = new FixedWindowLimiter(1, 60_000);
    limiter.hit('a', 0);
    expect(limiter.hit('a', 30_000).retryAfterSeconds).toBe(30);
  });

  it('forgets a key on demand, so a successful login clears the budget', () => {
    const limiter = new FixedWindowLimiter(1, 1000);

    limiter.hit('a', 0);
    limiter.reset('a');
    expect(limiter.hit('a', 1).allowed).toBe(true);
  });

  it('prunes finished windows instead of growing without bound', () => {
    const limiter = new FixedWindowLimiter(5, 1000);
    for (let i = 0; i < 100; i += 1) limiter.hit(`spray-${i}@example.com`, 0);
    expect(limiter.size).toBe(100);

    // Otherwise a credential-spraying attack is also a memory-exhaustion attack: every
    // distinct email is a key that never goes away.
    limiter.hit('later@example.com', 2000);
    expect(limiter.size).toBe(1);
  });
});

describe('configured limits match docs/03-auth-mfa.md', () => {
  it('login: 10 per 15 minutes', () => {
    expect(LOGIN_RATE_LIMIT).toEqual({ max: 10, timeWindow: 15 * 60 * 1000 });
  });

  it('register: 5 per hour', () => {
    expect(REGISTER_RATE_LIMIT).toEqual({ max: 5, timeWindow: 60 * 60 * 1000 });
  });
});
