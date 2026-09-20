import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/lib/errors.js';
import { mapError } from '../src/plugins/error-handler.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../src/plugins/csrf.js';

describe('mapError', () => {
  it('renders an AppError verbatim', () => {
    const mapped = mapError(new AppError(409, 'EMAIL_TAKEN', 'already exists'));

    expect(mapped.statusCode).toBe(409);
    expect(mapped.body).toEqual({ error: { code: 'EMAIL_TAKEN', message: 'already exists' } });
    expect(mapped.isUnexpected).toBe(false);
  });

  it('includes details only when the error carries them', () => {
    expect(
      mapError(new AppError(423, 'LOCKED', 'locked', { retryAfterSeconds: 900 })).body,
    ).toEqual({
      error: { code: 'LOCKED', message: 'locked', details: { retryAfterSeconds: 900 } },
    });
    expect('details' in mapError(new AppError(400, 'X', 'y')).body.error).toBe(false);
  });

  it('turns an unknown throw into an opaque 500', () => {
    const mapped = mapError(new Error('connection to 10.0.0.5 refused: password=hunter2'));

    expect(mapped.statusCode).toBe(500);
    // The interesting part: nothing from the original message survives. Driver errors
    // routinely carry hostnames, SQL and occasionally credentials.
    expect(mapped.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(mapped.isUnexpected).toBe(true);
  });

  it('keeps a Fastify 4xx and translates its code into this API vocabulary', () => {
    const fastifyError = Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 });
    expect(mapError(fastifyError)).toMatchObject({
      statusCode: 415,
      body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } },
      isUnexpected: false,
    });
  });

  it('maps a rate-limit 429 to RATE_LIMITED', () => {
    const limitError = Object.assign(new Error('Rate limit exceeded, retry in 1 minute'), {
      statusCode: 429,
    });
    expect(mapError(limitError)).toMatchObject({
      statusCode: 429,
      body: { error: { code: 'RATE_LIMITED' } },
    });
  });

  it('treats a 5xx from a library as unexpected', () => {
    const upstream = Object.assign(new Error('bad gateway'), { statusCode: 502 });
    expect(mapError(upstream)).toMatchObject({ statusCode: 500, isUnexpected: true });
  });

  it('survives a non-Error throw', () => {
    expect(mapError('nope')).toMatchObject({ statusCode: 500 });
    expect(mapError(undefined)).toMatchObject({ statusCode: 500 });
  });
});

describe('the error handler in a built app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab',
        SESSION_SECRET: 'a'.repeat(32),
        APP_ORIGIN: 'http://localhost:5173',
      }),
      checks: { checkDb: async () => ({ ok: true }) },
      rateLimits: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps a Zod request-validation failure to 400 VALIDATION_FAILED with field details', async () => {
    // Validation runs before the handler, so this never reaches Postgres.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
      payload: { email: 'not-an-email', password: 'short', displayName: '' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    const paths = (body.error.details as Array<{ path: string }>).map((d) => d.path);
    expect(paths).toContain('email');
    expect(paths).toContain('password');
  });

  it('never echoes the submitted password back in the error details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
      payload: { email: 'a@b.com', password: 'hunter2', displayName: 'A' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.payload).not.toContain('hunter2');
  });

  it('keeps x-request-id on an error response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('401s a guarded route with no cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});

describe('a database outage is reported as one, not as a bug', () => {
  /**
   * The failure a developer actually hits: `pnpm db:up` was never run, or Docker
   * restarted and the container did not come back. Before this mapping the whole
   * curriculum answered "Internal server error" with a 500, which reads like a defect in
   * the application and sends you reading the wrong code. The same reasoning that gives
   * Ollama its own `MODEL_UNAVAILABLE`.
   */
  const expectUnavailable = (error: unknown) => {
    const mapped = mapError(error);
    expect(mapped.statusCode).toBe(503);
    expect(mapped.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(mapped.body.error.message).toContain('pnpm db:up');
    // An outage is logged, but it is not a defect to go chasing.
    expect(mapped.isUnexpected).toBe(false);
  };

  it('maps a bare ECONNREFUSED', () => {
    expectUnavailable(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  });

  it('maps the AggregateError postgres.js actually throws', () => {
    // Observed shape: one leg per address it tried, `code` on the aggregate itself.
    const aggregate = Object.assign(
      new AggregateError([
        Object.assign(new Error('connect ECONNREFUSED ::1:5432'), {
          code: 'ECONNREFUSED',
        }),
      ]),
      { code: 'ECONNREFUSED' },
    );
    expectUnavailable(aggregate);
  });

  it('unwraps the DrizzleQueryError that actually reaches the handler', () => {
    // Drizzle wraps the driver's error, so the top level carries no socket code at all.
    const wrapped = Object.assign(new Error('Failed query: select ...'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expectUnavailable(wrapped);
  });

  it('does not mistake an ordinary bug for an outage', () => {
    expect(mapError(new Error('cannot read properties of undefined')).body.error.code).toBe(
      'INTERNAL_ERROR',
    );
  });

  it('terminates on a self-referential cause chain', () => {
    const looping: { cause?: unknown } = {};
    looping.cause = looping;
    expect(mapError(looping).body.error.code).toBe('INTERNAL_ERROR');
  });
});
