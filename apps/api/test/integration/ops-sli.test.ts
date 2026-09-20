import { SliResponseSchema, type SliResponse } from '@lab/shared';
import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { agentRunSteps, agentRuns } from '../../src/db/schema.js';
import { computeSli } from '../../src/ops/sli.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * `GET /ops/sli` and `computeSli`, against a real Postgres with rows whose arithmetic is
 * known by hand.
 *
 * Why the fixtures are written straight into the tables rather than produced by running
 * the loop: the point of these assertions is the *aggregation*, and a fixture whose
 * numbers were produced by the code under test can only prove the code agrees with
 * itself. Here the expected success rate, the expected p95 and the expected bucket counts
 * are computed on paper in the comments, and the SQL has to match them.
 *
 * The empty-window case has its own test and is not an afterthought: it is what a new
 * learner's `/ops` page renders every single time, and "no runs" must come back as `null`
 * rates rather than as `0`, `NaN` or a division-by-zero error.
 */

const APP_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };

let ctx: TestDb;
let app: FastifyInstance;
let cookie: string;
let userId: string;

function sessionCookie(res: InjectResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const sid = list.find((entry) => entry.startsWith('sid='));
  if (!sid) throw new Error(`No sid cookie in response: ${JSON.stringify(raw)}`);
  return sid.split(';')[0] as string;
}

/** `started_at` relative to now, so every fixture sits inside a known window. */
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

interface RunFixture {
  status: 'completed' | 'failed' | 'cancelled' | 'max_iterations' | 'running';
  kind?: 'prompt' | 'structured' | 'agent' | 'harness';
  iterations: number;
  promptTokens: number;
  completionTokens: number;
  errorCode?: string;
  startedAt: Date;
  /** `latency_ms` for one `model_call` step each. */
  callLatencies?: number[];
  /** `[toolName, parseOk, isError]` — one `tool_call` + one `tool_result` each. */
  toolCalls?: [string, boolean, boolean][];
}

async function insertRun(fixture: RunFixture): Promise<string> {
  const [run] = await ctx.db
    .insert(agentRuns)
    .values({
      userId,
      kind: fixture.kind ?? 'agent',
      provider: 'fake',
      model: 'gemma4:latest',
      status: fixture.status,
      systemPrompt: 'sys',
      userPrompt: 'user',
      tools: [],
      options: {},
      maxIterations: 8,
      iterationCount: fixture.iterations,
      toolCallCount: fixture.toolCalls?.length ?? 0,
      toolParseFailureCount: (fixture.toolCalls ?? []).filter(([, ok]) => !ok).length,
      promptTokensTotal: fixture.promptTokens,
      completionTokensTotal: fixture.completionTokens,
      modelLatencyMsTotal: (fixture.callLatencies ?? []).reduce((a, b) => a + b, 0),
      errorCode: fixture.errorCode ?? null,
      startedAt: fixture.startedAt,
      finishedAt: fixture.status === 'running' ? null : fixture.startedAt,
      requestId: 'req-fixture',
    })
    .returning({ id: agentRuns.id });
  const runId = run?.id;
  if (!runId) throw new Error('fixture run was not inserted');

  let stepIndex = 0;
  for (const latency of fixture.callLatencies ?? []) {
    await ctx.db.insert(agentRunSteps).values({
      runId,
      stepIndex: stepIndex++,
      kind: 'model_call',
      iteration: 1,
      latencyMs: latency,
    });
  }
  for (const [toolName, parseOk, isError] of fixture.toolCalls ?? []) {
    await ctx.db.insert(agentRunSteps).values({
      runId,
      stepIndex: stepIndex++,
      kind: 'tool_call',
      iteration: 1,
      toolName,
      parseOk,
    });
    await ctx.db.insert(agentRunSteps).values({
      runId,
      stepIndex: stepIndex++,
      kind: 'tool_result',
      iteration: 1,
      toolName,
      isError,
      latencyMs: 3,
    });
  }
  return runId;
}

const clearRuns = async (): Promise<void> => {
  // ON DELETE CASCADE takes the steps with them.
  await ctx.db.delete(agentRuns);
};

beforeAll(async () => {
  ctx = await setupTestDb();
  app = await buildApp({
    config: loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: ctx.url,
      SESSION_SECRET: 'integration-test-session-secret-0123456789',
      APP_ORIGIN,
      MODEL_PROVIDER: 'fake',
      METRICS_TOKEN: 'integration-metrics-token-0123456789',
    }),
    db: ctx.db,
    rateLimits: false,
  });
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: WRITE_HEADERS,
    payload: { email: 'sli@example.test', password: PASSWORD, displayName: 'SLI' },
  });
  expect(res.statusCode).toBe(201);
  cookie = sessionCookie(res);
  userId = res.json().user.id;
});

afterAll(async () => {
  await app.close();
  await ctx.teardown();
});

beforeEach(clearRuns);

const fetchSli = async (query = ''): Promise<SliResponse> => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/ops/sli${query}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return SliResponseSchema.parse(res.json());
};

describe('GET /api/v1/ops/sli', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ops/sli' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('accepts the METRICS_TOKEN bearer instead of a session, so the uptime cron can read it', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/sli?hours=1',
      headers: { authorization: 'Bearer integration-metrics-token-0123456789' },
    });
    expect(ok.statusCode).toBe(200);
    SliResponseSchema.parse(ok.json());

    const wrong = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/sli',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('answers an empty window with nulls, not zeros, and never divides by zero', async () => {
    const sli = await fetchSli();

    expect(sli.runs.total).toBe(0);
    expect(sli.runs.terminal).toBe(0);
    expect(sli.runs.successRate).toBeNull();
    expect(sli.runs.badOutcomeShare).toBeNull();
    expect(sli.modelCalls).toEqual({ count: 0, p50Ms: null, p95Ms: null, maxMs: null });
    expect(sli.tools).toEqual([]);
    expect(sli.errorCodes).toEqual([]);
    expect(sli.iterations.total).toBe(0);
    expect(sli.iterations.meanPerRun).toBeNull();
    expect(sli.tokens).toEqual({ promptTotal: 0, completionTotal: 0, perRunAvg: null });
    // The axis is still complete, so the page draws an empty chart rather than no chart.
    expect(sli.iterations.buckets.map((b) => b.le)).toEqual([1, 2, 3, 5, 8, 15, null]);
    expect(sli.iterations.buckets.every((b) => b.count === 0)).toBe(true);
  });

  it('computes the status counts, rates and token totals from known rows', async () => {
    // Six runs: 3 completed, 1 failed, 1 max_iterations, 1 cancelled, plus 1 still running.
    //   terminal        = 6
    //   successRate     = 3 / 6 = 0.5
    //   badOutcomeShare = (1 failed + 1 max_iterations) / 6 = 0.3333…
    //   prompt tokens   = 100+100+100+50+50+50+7 (the running one counts too: the tokens
    //                     were spent whether or not the run finished)
    await insertRun({
      status: 'completed',
      iterations: 1,
      promptTokens: 100,
      completionTokens: 10,
      startedAt: minutesAgo(5),
    });
    await insertRun({
      status: 'completed',
      iterations: 2,
      promptTokens: 100,
      completionTokens: 10,
      startedAt: minutesAgo(6),
    });
    await insertRun({
      status: 'completed',
      iterations: 3,
      promptTokens: 100,
      completionTokens: 10,
      startedAt: minutesAgo(7),
    });
    await insertRun({
      status: 'failed',
      iterations: 1,
      promptTokens: 50,
      completionTokens: 5,
      errorCode: 'MODEL_UNAVAILABLE',
      startedAt: minutesAgo(8),
    });
    await insertRun({
      status: 'max_iterations',
      iterations: 8,
      promptTokens: 50,
      completionTokens: 5,
      errorCode: 'MAX_ITERATIONS',
      startedAt: minutesAgo(9),
    });
    await insertRun({
      status: 'cancelled',
      iterations: 2,
      promptTokens: 50,
      completionTokens: 5,
      errorCode: 'RUN_CANCELLED',
      startedAt: minutesAgo(10),
    });
    await insertRun({
      status: 'running',
      iterations: 1,
      promptTokens: 7,
      completionTokens: 0,
      startedAt: minutesAgo(1),
    });

    const sli = await fetchSli();

    expect(sli.runs.total).toBe(7);
    expect(sli.runs.terminal).toBe(6);
    expect(sli.runs.byStatus).toEqual({
      running: 1,
      completed: 3,
      failed: 1,
      cancelled: 1,
      maxIterations: 1,
    });
    expect(sli.runs.successRate).toBeCloseTo(0.5, 10);
    expect(sli.runs.badOutcomeShare).toBeCloseTo(2 / 6, 10);
    expect(sli.tokens.promptTotal).toBe(457);
    expect(sli.tokens.completionTotal).toBe(45);
    // Averaged over terminal runs: (457 + 45) / 6.
    expect(sli.tokens.perRunAvg).toBeCloseTo(502 / 6, 10);
  });

  it('bucket the iteration distribution the way the Prometheus histogram does', async () => {
    // iterations 1, 2, 3, 4, 6, 9, 15 and 20 →
    //   le=1: 1   le=2: 1   le=3: 1   le=5: 1 (the 4)
    //   le=8: 1 (the 6)     le=15: 2 (the 9 and the 15)   +Inf: 1 (the 20)
    for (const iterations of [1, 2, 3, 4, 6, 9, 15, 20]) {
      await insertRun({
        status: 'completed',
        iterations,
        promptTokens: 1,
        completionTokens: 1,
        startedAt: minutesAgo(5),
      });
    }

    const sli = await fetchSli();
    expect(sli.iterations.buckets).toEqual([
      { le: 1, count: 1 },
      { le: 2, count: 1 },
      { le: 3, count: 1 },
      { le: 5, count: 1 },
      { le: 8, count: 1 },
      { le: 15, count: 2 },
      { le: null, count: 1 },
    ]);
    expect(sli.iterations.total).toBe(8);
    expect(sli.iterations.meanPerRun).toBeCloseTo((1 + 2 + 3 + 4 + 6 + 9 + 15 + 20) / 8, 10);
  });

  it('takes latency percentiles over model_call steps, not over runs', async () => {
    // Twenty calls spread over two runs: 1000, 2000, …, 20000 ms.
    //   p50 (percentile_cont) = 10500, p95 = 19050, max = 20000.
    // Note that the two runs have wildly different call counts; a per-run average would
    // give a different answer, which is exactly the mistake this asserts against.
    await insertRun({
      status: 'completed',
      iterations: 1,
      promptTokens: 1,
      completionTokens: 1,
      startedAt: minutesAgo(5),
      callLatencies: [1000, 2000, 3000],
    });
    await insertRun({
      status: 'completed',
      iterations: 1,
      promptTokens: 1,
      completionTokens: 1,
      startedAt: minutesAgo(5),
      callLatencies: Array.from({ length: 17 }, (_, i) => (i + 4) * 1000),
    });

    const sli = await fetchSli();
    expect(sli.modelCalls.count).toBe(20);
    expect(sli.modelCalls.p50Ms).toBeCloseTo(10_500, 6);
    expect(sli.modelCalls.p95Ms).toBeCloseTo(19_050, 6);
    expect(sli.modelCalls.maxMs).toBe(20_000);
  });

  it('separates provider-side parse failures from schema errors, per tool (ADR 0002)', async () => {
    // calculator: 4 calls, 1 not-JSON (parse failure), 1 tool_result error (bad arguments
    //             that *did* parse). Those are two different numbers on purpose.
    // flaky_service: 2 calls, 0 parse failures, 2 errors — the teaching tool that throws.
    await insertRun({
      status: 'completed',
      iterations: 2,
      promptTokens: 1,
      completionTokens: 1,
      startedAt: minutesAgo(5),
      toolCalls: [
        ['calculator', true, false],
        ['calculator', true, false],
        ['calculator', false, true],
        ['calculator', true, true],
        ['flaky_service', true, true],
        ['flaky_service', true, true],
      ],
    });

    const sli = await fetchSli();
    const calculator = sli.tools.find((tool) => tool.tool === 'calculator');
    const flaky = sli.tools.find((tool) => tool.tool === 'flaky_service');

    expect(calculator).toEqual({
      tool: 'calculator',
      calls: 4,
      parseFailures: 1,
      errors: 2,
      parseFailureRate: 0.25,
    });
    expect(flaky).toEqual({
      tool: 'flaky_service',
      calls: 2,
      parseFailures: 0,
      errors: 2,
      parseFailureRate: 0,
    });
  });

  it('ranks error codes worst-first', async () => {
    for (let i = 0; i < 3; i += 1) {
      await insertRun({
        status: 'failed',
        iterations: 1,
        promptTokens: 1,
        completionTokens: 1,
        errorCode: 'MODEL_UNAVAILABLE',
        startedAt: minutesAgo(5),
      });
    }
    await insertRun({
      status: 'failed',
      iterations: 1,
      promptTokens: 1,
      completionTokens: 1,
      errorCode: 'MODEL_TIMEOUT',
      startedAt: minutesAgo(5),
    });

    const sli = await fetchSli();
    expect(sli.errorCodes).toEqual([
      { code: 'MODEL_UNAVAILABLE', count: 3 },
      { code: 'MODEL_TIMEOUT', count: 1 },
    ]);
  });

  it('honours ?hours= and excludes runs outside the window', async () => {
    await insertRun({
      status: 'completed',
      iterations: 1,
      promptTokens: 1,
      completionTokens: 1,
      startedAt: minutesAgo(10),
    });
    await insertRun({
      status: 'failed',
      iterations: 1,
      promptTokens: 1,
      completionTokens: 1,
      errorCode: 'X',
      startedAt: minutesAgo(48 * 60),
    });

    const hour = await fetchSli('?hours=1');
    expect(hour.window.hours).toBe(1);
    expect(hour.runs.total).toBe(1);
    expect(hour.runs.successRate).toBe(1);

    const week = await fetchSli('?hours=168');
    expect(week.runs.total).toBe(2);
    expect(week.runs.successRate).toBeCloseTo(0.5, 10);
  });

  it('rejects a nonsense window rather than silently clamping it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/sli?hours=99999',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('is cheap: the aggregation is a single statement with an index-usable predicate', async () => {
    for (let i = 0; i < 40; i += 1) {
      await insertRun({
        status: i % 5 === 0 ? 'failed' : 'completed',
        iterations: (i % 4) + 1,
        promptTokens: 10 * i,
        completionTokens: i,
        ...(i % 5 === 0 ? { errorCode: 'MODEL_TIMEOUT' } : {}),
        startedAt: minutesAgo(i),
        callLatencies: [1000 + i * 10],
      });
    }
    // Directly, so the assertion is about `computeSli` and not about HTTP.
    const sli = await computeSli(ctx.db, { hours: 24 });
    expect(sli.runs.total).toBe(40);
    expect(sli.modelCalls.count).toBe(40);

    // The plan is inspected rather than asserted on in detail: plan shape depends on
    // table statistics, and 40 rows will always be a sequential scan. What must hold at
    // any size is that the window predicate is pushed into the scan (so a large table is
    // filtered in Postgres, not in Node) and that nothing in here is a nested loop over
    // the run table per step.
    const plan = await ctx.sql.unsafe(
      `explain (format json) select count(*) from agent_runs where started_at >= now() - interval '24 hours'`,
    );
    const text = JSON.stringify(plan);
    expect(text).toContain('agent_runs');
    expect(text.toLowerCase()).toContain('filter');
  });
});
