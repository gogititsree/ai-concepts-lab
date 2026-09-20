import { HealthResponseSchema } from '@lab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const testConfig = () =>
  loadConfig({
    NODE_ENV: 'test',
    GIT_SHA: 'test-sha',
    DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab',
  });

/**
 * Unit-level: the database probe is injected, so this suite never opens a socket. The
 * real `SELECT 1` is covered by `test/integration/health.test.ts`.
 */
describe('GET /api/v1/health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      config: testConfig(),
      // Both probes are injected: this suite must not open a socket, and M15's
      // schema-drift check is a real `information_schema` query when it is not stubbed.
      checks: { checkDb: async () => ({ ok: true }), checkSchema: async () => ({ ok: true }) },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a payload matching the shared contract', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.statusCode).toBe(200);
    const body = HealthResponseSchema.parse(res.json());
    expect(body).toEqual({
      status: 'ok',
      version: 'test-sha',
      checks: { db: { ok: true }, schema: { ok: true } },
    });
  });

  it('reports the service as down when the database check fails', async () => {
    const downApp = await buildApp({
      config: testConfig(),
      checks: {
        checkDb: async () => ({ ok: false, detail: 'connection refused' }),
        checkSchema: async () => ({ ok: true }),
      },
    });
    await downApp.ready();
    try {
      const res = await downApp.inject({ method: 'GET', url: '/api/v1/health' });
      // Still HTTP 200: the endpoint answered, and the body is what carries the verdict.
      // A monitor that pages on the body can distinguish down from unreachable.
      expect(res.statusCode).toBe(200);
      const body = HealthResponseSchema.parse(res.json());
      expect(body.status).toBe('down');
      expect(body.checks.db).toEqual({ ok: false, detail: 'connection refused' });
    } finally {
      await downApp.close();
    }
  });

  /**
   * The M15 action item. `checks.db` passing while the application is unable to serve is
   * exactly what the bad-migration incident looked like from the outside, so the mapping
   * "schema drift => down" gets its own test rather than riding on the db case.
   */
  it('reports the service as down when the schema does not match the build', async () => {
    const driftApp = await buildApp({
      config: testConfig(),
      checks: {
        checkDb: async () => ({ ok: true }),
        checkSchema: async () => ({
          ok: false,
          detail:
            'the database is missing 1 column(s) this build expects: agent_runs.final_output.',
        }),
      },
    });
    await driftApp.ready();
    try {
      const res = await driftApp.inject({ method: 'GET', url: '/api/v1/health' });
      const body = HealthResponseSchema.parse(res.json());
      expect(body.status).toBe('down');
      expect(body.checks.db.ok).toBe(true);
      expect(body.checks.schema.ok).toBe(false);
      expect(body.checks.schema.detail).toContain('agent_runs.final_output');
    } finally {
      await driftApp.close();
    }
  });

  it('does not run the schema check when the database is unreachable', async () => {
    let called = 0;
    const downApp = await buildApp({
      config: testConfig(),
      checks: {
        checkDb: async () => ({ ok: false, detail: 'connection refused' }),
        checkSchema: async () => {
          called += 1;
          return { ok: true };
        },
      },
    });
    await downApp.ready();
    try {
      await downApp.inject({ method: 'GET', url: '/api/v1/health' });
      // Asking information_schema over a socket that is already refusing connections
      // replaces a precise error with a confusing one.
      expect(called).toBe(0);
    } finally {
      await downApp.close();
    }
  });

  it('caches the schema check rather than querying on every probe', async () => {
    let called = 0;
    const cachedApp = await buildApp({
      config: testConfig(),
      checks: {
        checkDb: async () => ({ ok: true }),
        checkSchema: async () => {
          called += 1;
          return { ok: true };
        },
      },
    });
    await cachedApp.ready();
    try {
      await cachedApp.inject({ method: 'GET', url: '/api/v1/health' });
      await cachedApp.inject({ method: 'GET', url: '/api/v1/health' });
      await cachedApp.inject({ method: 'GET', url: '/api/v1/health' });
      expect(called).toBe(1);
    } finally {
      await cachedApp.close();
    }
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
