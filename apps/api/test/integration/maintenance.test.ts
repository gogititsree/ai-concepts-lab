import { randomBytes } from 'node:crypto';

import { eq, sql as raw } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { EXPIRED_SESSION_GRACE_MS, PENDING_MFA_TTL_MS } from '../../src/auth/housekeeping.js';
import { agentRunSteps, agentRuns, mfaTotp, sessions, users } from '../../src/db/schema.js';
import { RUN_RETENTION_DAYS, STEP_RAW_RETENTION_DAYS } from '../../src/ops/maintenance.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * `POST /api/v1/ops/maintenance` (M13, decision 13).
 *
 * The retention assertions insert rows with an explicit age rather than mocking a clock.
 * That is the only way to test this honestly: the thing that can be wrong is the SQL
 * predicate — a `>` where a `<` belongs, a cutoff computed from the wrong column, a
 * cascade that does not cascade — and none of those is visible unless real rows with
 * real timestamps go in and the survivors are counted afterwards.
 */

const APP_ORIGIN = 'http://localhost:5173';
const TOKEN = 'maintenance-token-for-the-integration-suite';
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };
const DAY_MS = 24 * 60 * 60 * 1000;

let ctx: TestDb;
let app: FastifyInstance;
let disabledApp: FastifyInstance;
let userId: string;

const config = (maintenanceToken: string | undefined) =>
  loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: ctx.url,
    SESSION_SECRET: 'integration-test-session-secret-0123456789',
    APP_ORIGIN,
    MODEL_PROVIDER: 'fake',
    MAINTENANCE_TOKEN: maintenanceToken,
  });

const post = (headers: Record<string, string>, target = app) =>
  target.inject({ method: 'POST', url: '/api/v1/ops/maintenance', headers });

const withToken = (token = TOKEN) => ({ ...WRITE_HEADERS, authorization: `Bearer ${token}` });

/** An `agent_runs` row whose `started_at` is exactly `ageDays` old. */
async function insertRun(ageDays: number, rawAgeDays = ageDays): Promise<string> {
  const startedAt = new Date(Date.now() - ageDays * DAY_MS);
  const [run] = await ctx.db
    .insert(agentRuns)
    .values({
      userId,
      kind: 'agent',
      provider: 'fake',
      model: 'fake',
      status: 'completed',
      systemPrompt: 'system',
      userPrompt: 'user',
      maxIterations: 5,
      requestId: `req-${randomBytes(4).toString('hex')}`,
      startedAt,
      finishedAt: startedAt,
    })
    .returning({ id: agentRuns.id });
  const runId = run!.id;

  await ctx.db.insert(agentRunSteps).values({
    runId,
    stepIndex: 0,
    kind: 'model_call',
    iteration: 1,
    content: 'hello',
    // The bulky column the second retention rule exists for.
    raw: { total_duration: 1234, prompt_eval_cached_count: 7 },
    createdAt: new Date(Date.now() - rawAgeDays * DAY_MS),
  });

  return runId;
}

const countRuns = async (): Promise<number> => {
  const rows = await ctx.db.select({ n: raw<number>`count(*)::int` }).from(agentRuns);
  return rows[0]?.n ?? 0;
};

const countSteps = async (): Promise<number> => {
  const rows = await ctx.db.select({ n: raw<number>`count(*)::int` }).from(agentRunSteps);
  return rows[0]?.n ?? 0;
};

beforeAll(async () => {
  ctx = await setupTestDb({ seed: false });
  app = await buildApp({
    config: config(TOKEN),
    db: ctx.db,
    rateLimits: false,
    checks: { checkDb: async () => ({ ok: true }) },
  });
  await app.ready();
  disabledApp = await buildApp({
    config: config(undefined),
    db: ctx.db,
    rateLimits: false,
    checks: { checkDb: async () => ({ ok: true }) },
  });
  await disabledApp.ready();

  const [user] = await ctx.db
    .insert(users)
    .values({
      email: 'maintenance@example.test',
      passwordHash: 'not-a-real-hash',
      displayName: 'Maintenance',
    })
    .returning({ id: users.id });
  userId = user!.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await disabledApp?.close();
  await ctx?.teardown();
});

describe('authorisation', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await post(WRITE_HEADERS);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a wrong token', async () => {
    const res = await post(withToken('wrong-token-of-a-perfectly-plausible-length'));
    expect(res.statusCode).toBe(401);
    // Same code and message as "no header at all": the response must not be an oracle
    // that tells a prober whether they are close.
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const res = await post(withToken(TOKEN.slice(0, -1)));
    expect(res.statusCode).toBe(401);
  });

  it('rejects the right token sent as something other than Bearer', async () => {
    const res = await post({ ...WRITE_HEADERS, authorization: TOKEN });
    expect(res.statusCode).toBe(401);
  });

  it('is still refused without the CSRF header, like every other write', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ops/maintenance',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('answers 503, not 401, when the instance has no token configured', async () => {
    // "Switched off" and "you got the password wrong" are different problems, and the
    // person debugging the schedule at 2am needs to be told which one they have.
    const res = await post(withToken(), disabledApp);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('MAINTENANCE_DISABLED');
  });

  it('accepts the correct token and returns counts', async () => {
    const res = await post(withToken());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionsDeleted: expect.any(Number),
      pendingMfaDeleted: expect.any(Number),
      agentRunsDeleted: expect.any(Number),
      stepRawCleared: expect.any(Number),
      durationMs: expect.any(Number),
    });
    expect(typeof res.json().ranAt).toBe('string');
  });
});

describe('what the sweep actually deletes', () => {
  it('deletes agent runs past the retention window and keeps the rest', async () => {
    const old = await insertRun(RUN_RETENTION_DAYS + 1);
    const justInside = await insertRun(RUN_RETENTION_DAYS - 1);
    const fresh = await insertRun(0);

    const before = await countRuns();
    const res = await post(withToken());
    expect(res.statusCode).toBe(200);

    const surviving = await ctx.db.select({ id: agentRuns.id }).from(agentRuns);
    const ids = surviving.map((row) => row.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(justInside);
    expect(ids).toContain(fresh);
    // The reported count is the real count, not an optimistic guess.
    expect(res.json().agentRunsDeleted).toBe(before - surviving.length);
    expect(res.json().agentRunsDeleted).toBe(1);
  });

  it("cascades to the deleted run's steps", async () => {
    await insertRun(RUN_RETENTION_DAYS + 5);
    const stepsBefore = await countSteps();

    await post(withToken());

    // One run deleted, one step gone with it — the FK cascade, not a second statement.
    expect(await countSteps()).toBe(stepsBefore - 1);
  });

  it('nulls raw on old steps whose run is still inside the retention window', async () => {
    // The interesting case: the run is young enough to keep, the step's bulky payload
    // is old enough to drop.
    const runId = await insertRun(STEP_RAW_RETENTION_DAYS + 1, STEP_RAW_RETENTION_DAYS + 1);

    const res = await post(withToken());
    expect(res.json().stepRawCleared).toBeGreaterThanOrEqual(1);

    const steps = await ctx.db
      .select({ raw: agentRunSteps.raw, kind: agentRunSteps.kind })
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, runId));
    expect(steps).toHaveLength(1);
    // The row survives with everything the trace viewer and /ops/sli read; only the
    // provider blob is gone.
    expect(steps[0]!.raw).toBeNull();
    expect(steps[0]!.kind).toBe('model_call');
  });

  it("leaves a recent step's raw alone", async () => {
    const runId = await insertRun(1, 1);

    await post(withToken());

    const steps = await ctx.db
      .select({ raw: agentRunSteps.raw })
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, runId));
    expect(steps[0]!.raw).not.toBeNull();
  });

  it('does not re-count rows it already cleared', async () => {
    await insertRun(STEP_RAW_RETENTION_DAYS + 2, STEP_RAW_RETENTION_DAYS + 2);

    const first = await post(withToken());
    expect(first.json().stepRawCleared).toBeGreaterThanOrEqual(1);
    const second = await post(withToken());
    // Without the `raw IS NOT NULL` predicate this would report the same rows forever
    // and the number would stop meaning anything.
    expect(second.json().stepRawCleared).toBe(0);
  });

  it('deletes expired sessions past the forensic grace period, and pending MFA rows', async () => {
    const expiredLongAgo = randomBytes(32);
    const expiredRecently = randomBytes(32);
    await ctx.db.insert(sessions).values([
      {
        id: expiredLongAgo,
        userId,
        expiresAt: new Date(Date.now() - EXPIRED_SESSION_GRACE_MS - DAY_MS),
      },
      // Expired, but inside the week the housekeeping doc keeps for incident forensics.
      { id: expiredRecently, userId, expiresAt: new Date(Date.now() - 60_000) },
    ]);
    await ctx.db.insert(mfaTotp).values({
      userId,
      secretCiphertext: Buffer.from('x'),
      secretIv: Buffer.from('y'),
      secretTag: Buffer.from('z'),
      createdAt: new Date(Date.now() - PENDING_MFA_TTL_MS - 60_000),
    });

    const res = await post(withToken());

    expect(res.json().sessionsDeleted).toBe(1);
    expect(res.json().pendingMfaDeleted).toBe(1);
    const remaining = await ctx.db.select({ id: sessions.id }).from(sessions);
    expect(remaining).toHaveLength(1);
    expect(Buffer.from(remaining[0]!.id).equals(expiredRecently)).toBe(true);
  });
});
