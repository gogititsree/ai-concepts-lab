import { HealthResponseSchema } from '@lab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('GET /api/v1/health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', GIT_SHA: 'test-sha' }) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a payload matching the shared contract', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.statusCode).toBe(200);
    const body = HealthResponseSchema.parse(res.json());
    expect(body).toEqual({ status: 'ok', version: 'test-sha', checks: {} });
  });

  it('sets x-request-id on the response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('404s unknown API routes as JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
