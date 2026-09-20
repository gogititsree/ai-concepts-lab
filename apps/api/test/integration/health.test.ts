import { HealthResponseSchema } from '@lab/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { checkDbHealth } from '../../src/db/health.js';
import { checkSchemaDrift } from '../../src/db/schemaCheck.js';
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
      // `db` as well as `config`: `buildApp` falls back to the module-level client built
      // from the *process* DATABASE_URL, so without this the schema check added in M15
      // would inspect the shared development database instead of this file's throwaway
      // one — and would pass no matter what this test did to the schema.
      db: ctx.db,
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
    // M15: a migrated database matches the build, so the drift check is silent. If this
    // ever fails, a migration was generated and the schema was not regenerated with it.
    expect(body.checks.schema).toEqual({ ok: true });
  });

  /**
   * The regression test for the M15 bad-migration incident
   * (`docs/postmortems/2026-09-20-rename-final-output.md`).
   *
   * The rename is reproduced exactly: `agent_runs.final_output` becomes `output` while
   * the code still declares `final_output`. Before this check existed, `/health` reported
   * `ok` in that state and `deploy.yml` went green while every run route answered 500.
   */
  it('detects the rename that caused the M15 incident and reports down', async () => {
    await ctx.sql.unsafe('ALTER TABLE agent_runs RENAME COLUMN final_output TO output');
    try {
      const drift = await checkSchemaDrift(ctx.db);
      expect(drift.ok).toBe(false);
      expect(drift.missing).toContain('agent_runs.final_output');
      expect(drift.detail).toContain('agent_runs.final_output');

      // And it reaches the endpoint that `deploy.yml` and `uptime.yml` already poll.
      // A fresh app, because the route caches the result for SCHEMA_CHECK_TTL_MS.
      const driftApp = await buildApp({
        config: loadConfig({ ...process.env, NODE_ENV: 'test', DATABASE_URL: ctx.url }),
        db: ctx.db,
        checks: { checkDb: () => checkDbHealth(ctx.sql) },
      });
      await driftApp.ready();
      try {
        const body = HealthResponseSchema.parse(
          (await driftApp.inject({ method: 'GET', url: '/api/v1/health' })).json(),
        );
        expect(body.status).toBe('down');
        expect(body.checks.db.ok).toBe(true);
        expect(body.checks.schema.ok).toBe(false);
      } finally {
        await driftApp.close();
      }
    } finally {
      await ctx.sql.unsafe('ALTER TABLE agent_runs RENAME COLUMN output TO final_output');
    }
  }, 30_000);

  /**
   * The other half of the contract, and the more important one to get right: a column the
   * database has and the code does not is the **expand** phase of expand/contract. The
   * runbook tells you to do exactly this, so the check must not call it drift.
   */
  it('does not treat an extra database column as drift', async () => {
    await ctx.sql.unsafe('ALTER TABLE agent_runs ADD COLUMN output text');
    try {
      const drift = await checkSchemaDrift(ctx.db);
      expect(drift.ok).toBe(true);
      expect(drift.missing).toEqual([]);
    } finally {
      await ctx.sql.unsafe('ALTER TABLE agent_runs DROP COLUMN output');
    }
  }, 30_000);

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
