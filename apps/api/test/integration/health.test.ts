import { HealthResponseSchema } from '@lab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { checkDbHealth } from '../../src/db/health.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * The unit suite stubs the database probe; this one runs it for real, so a change that
 * breaks the connection string, the pool or the query itself cannot pass CI.
 */
describe('GET /api/v1/health against a real database', () => {
  let ctx: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    ctx = await setupTestDb({ seed: false });
    app = await buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test', DATABASE_URL: ctx.url }),
      checks: { checkDb: () => checkDbHealth(ctx.sql) },
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  it('reports checks.db.ok === true', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.statusCode).toBe(200);
    const body = HealthResponseSchema.parse(res.json());
    expect(body.status).toBe('ok');
    expect(body.checks.db).toEqual({ ok: true });
  });

  it('reports the database as down when the connection is unusable', async () => {
    // Port 1 is reserved and nothing listens on it, so this exercises the failure branch
    // (and the timeout) rather than a mocked rejection.
    const { createDbClient } = await import('../../src/db/client.js');
    const broken = createDbClient('postgres://lab:lab@127.0.0.1:1/lab', {
      max: 1,
      connectTimeout: 1,
    });
    try {
      const check = await checkDbHealth(broken.sql, 2_000);
      expect(check.ok).toBe(false);
      expect(check.detail).toBeTruthy();
    } finally {
      await broken.close().catch(() => {});
    }
  }, 15_000);
});
