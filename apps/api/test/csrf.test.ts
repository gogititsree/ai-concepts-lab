import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE, evaluateCsrf } from '../src/plugins/csrf.js';

const APP_ORIGIN = 'http://localhost:5173';

const allowed = (input: Partial<Parameters<typeof evaluateCsrf>[0]> = {}) =>
  evaluateCsrf({
    method: 'POST',
    url: '/api/v1/auth/login',
    requestedWith: CSRF_HEADER_VALUE,
    appOrigin: APP_ORIGIN,
    ...input,
  });

describe('evaluateCsrf', () => {
  it('exempts safe methods, which change nothing', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'options']) {
      expect(allowed({ method, requestedWith: undefined }).allowed).toBe(true);
    }
  });

  it('ignores requests outside /api', () => {
    expect(allowed({ url: '/anything', requestedWith: undefined }).allowed).toBe(true);
  });

  it('requires the custom header on state-changing API requests', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const decision = allowed({ method, requestedWith: undefined });
      expect(decision).toMatchObject({ allowed: false, reason: 'missing_header' });
    }
  });

  it('rejects a wrong header value', () => {
    expect(allowed({ requestedWith: 'XMLHttpRequest' })).toMatchObject({
      allowed: false,
      reason: 'missing_header',
    });
  });

  it('accepts the header case-insensitively', () => {
    expect(allowed({ requestedWith: 'FETCH' }).allowed).toBe(true);
  });

  it('accepts a matching Origin', () => {
    expect(allowed({ origin: APP_ORIGIN }).allowed).toBe(true);
    // Only the origin is compared, so a path on the header does not matter.
    expect(allowed({ origin: `${APP_ORIGIN}/login` }).allowed).toBe(true);
  });

  it('rejects a foreign Origin', () => {
    expect(allowed({ origin: 'https://evil.example' })).toMatchObject({
      allowed: false,
      reason: 'origin_mismatch',
    });
    // Same host, different port: a different origin, and treated as one.
    expect(allowed({ origin: 'http://localhost:5174' }).allowed).toBe(false);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(allowed({ referer: `${APP_ORIGIN}/settings` }).allowed).toBe(true);
    expect(allowed({ referer: 'https://evil.example/x' }).allowed).toBe(false);
  });

  it('prefers Origin over Referer when both are present', () => {
    expect(allowed({ origin: APP_ORIGIN, referer: 'https://evil.example/x' }).allowed).toBe(true);
  });

  it('allows a request with neither Origin nor Referer', () => {
    // curl and server-to-server callers legitimately send neither; the header check is
    // what protects them, and demanding Origin would only break non-browser clients.
    expect(allowed({}).allowed).toBe(true);
  });

  it('treats an opaque or unparseable Origin as absent', () => {
    expect(allowed({ origin: 'null' }).allowed).toBe(true);
    expect(allowed({ origin: 'not a url' }).allowed).toBe(true);
  });

  it('reads the first value when a header is repeated', () => {
    expect(allowed({ origin: ['https://evil.example', APP_ORIGIN] }).allowed).toBe(false);
  });
});

/**
 * End-to-end through the hook. `/api/v1/does-not-exist` is deliberate: the CSRF hook runs
 * on `onRequest`, long before routing, so this exercises the real plugin without needing
 * a database-backed route.
 */
describe('the CSRF hook in a built app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab',
        SESSION_SECRET: 'a'.repeat(32),
        APP_ORIGIN,
      }),
      checks: { checkDb: async () => ({ ok: true }) },
      rateLimits: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('403s a POST without the header', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/does-not-exist' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('403s a POST from a foreign origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/does-not-exist',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: 'https://evil.example' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'CSRF_REJECTED', details: { reason: 'origin_mismatch' } },
    });
  });

  it('lets a correctly-headed POST through to routing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/does-not-exist',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN },
    });

    expect(res.statusCode).toBe(404);
  });

  it('never blocks GET /health, which uptime monitors call without headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
  });
});
