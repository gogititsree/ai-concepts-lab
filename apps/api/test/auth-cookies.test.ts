import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  readSessionToken,
  sessionCookieOptions,
  setSessionCookie,
} from '../src/auth/cookies.js';
import { ABSOLUTE_TIMEOUT_MS } from '../src/auth/session.js';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab',
  SESSION_SECRET: 'a'.repeat(32),
  APP_ORIGIN: 'http://localhost:5173',
};

const devConfig = loadConfig({ ...baseEnv, NODE_ENV: 'development' });
const prodConfig = loadConfig({ ...baseEnv, NODE_ENV: 'production' });

interface RecordedCookie {
  name: string;
  value?: string;
  options: CookieSerializeOptions;
}

function fakeReply(): { reply: FastifyReply; set: RecordedCookie[]; cleared: RecordedCookie[] } {
  const set: RecordedCookie[] = [];
  const cleared: RecordedCookie[] = [];
  const reply = {
    setCookie: (name: string, value: string, options: CookieSerializeOptions) => {
      set.push({ name, value, options });
      return reply;
    },
    clearCookie: (name: string, options: CookieSerializeOptions) => {
      cleared.push({ name, options });
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, set, cleared };
}

describe('session cookie attributes', () => {
  it('is HttpOnly, SameSite=Lax, Path=/ and signed', () => {
    const options = sessionCookieOptions(devConfig);

    // HttpOnly is the flag that keeps an XSS bug from becoming a stolen session.
    expect(options.httpOnly).toBe(true);
    // Lax still sends the cookie when the user follows a link into the app, but not on a
    // cross-site POST — which is the CSRF case.
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.signed).toBe(true);
  });

  it('expires with the absolute session lifetime, not the idle one', () => {
    // A browser that keeps the cookie past the absolute deadline would just be sending a
    // credential the server always rejects.
    expect(sessionCookieOptions(devConfig).maxAge).toBe(ABSOLUTE_TIMEOUT_MS / 1000);
  });

  it('sets Secure in production and leaves it off in development', () => {
    // Secure on http://localhost means the browser silently drops the cookie, which looks
    // exactly like a broken login.
    expect(sessionCookieOptions(prodConfig).secure).toBe(true);
    expect(sessionCookieOptions(devConfig).secure).toBe(false);
  });

  it('honours an explicit COOKIE_SECURE override', () => {
    const forced = loadConfig({ ...baseEnv, NODE_ENV: 'development', COOKIE_SECURE: 'true' });
    expect(sessionCookieOptions(forced).secure).toBe(true);
  });

  it('writes the token under the documented cookie name', () => {
    const { reply, set } = fakeReply();
    setSessionCookie(reply, 'the-token', devConfig);

    expect(set).toHaveLength(1);
    expect(set[0]?.name).toBe(SESSION_COOKIE_NAME);
    expect(set[0]?.value).toBe('the-token');
  });

  it('clears with the same attributes but no Max-Age', () => {
    const { reply, cleared } = fakeReply();
    clearSessionCookie(reply, devConfig);

    expect(cleared).toHaveLength(1);
    // Path/SameSite must match the original or the browser keeps the old cookie.
    expect(cleared[0]?.options.path).toBe('/');
    expect(cleared[0]?.options.sameSite).toBe('lax');
    expect(cleared[0]?.options.httpOnly).toBe(true);
    expect(cleared[0]?.options.maxAge).toBeUndefined();
  });
});

describe('readSessionToken', () => {
  function fakeRequest(cookies: Record<string, string>, valid = true): FastifyRequest {
    return {
      cookies,
      unsignCookie: (value: string) => ({
        valid,
        renew: false,
        value: valid ? value.split('.')[0] : null,
      }),
    } as unknown as FastifyRequest;
  }

  it('returns null when there is no cookie', () => {
    expect(readSessionToken(fakeRequest({}))).toBeNull();
  });

  it('returns the unsigned token for a valid signature', () => {
    expect(readSessionToken(fakeRequest({ sid: 'tok.sig' }))).toBe('tok');
  });

  it('returns null when the signature does not verify', () => {
    // A forged cookie is discarded before it costs a database round-trip.
    expect(readSessionToken(fakeRequest({ sid: 'tok.bad' }, false))).toBeNull();
  });
});
