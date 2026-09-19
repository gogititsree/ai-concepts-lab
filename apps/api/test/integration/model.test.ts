import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { contentId } from '../../src/db/uuid5.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * `/api/v1/model/*` against a real Postgres and `MODEL_PROVIDER=fake`.
 *
 * What these tests are actually about is the **persistence**, not the inference: that one
 * call leaves exactly the rows docs/02-schema.md says it should, that a structured retry
 * leaves two `model_call` steps rather than one, that the rollup counters add up, and
 * that another user cannot read the trace. The provider is scripted precisely so those
 * assertions can be exact.
 *
 * A second app is built with `MODEL_PROVIDER=none` in the same process, which is why
 * `createProvider` is a factory rather than a singleton.
 */

const APP_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };

const DATES_SCHEMA = {
  type: 'object',
  properties: {
    dates: { type: 'array', items: { type: 'string' }, minItems: 3 },
  },
  required: ['dates'],
};

let ctx: TestDb;
let app: FastifyInstance;
let noModelApp: FastifyInstance;
let cookie: string;
let otherCookie: string;

function sessionCookie(res: InjectResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const sid = list.find((entry) => entry.startsWith('sid='));
  if (!sid) throw new Error(`No sid cookie in response: ${JSON.stringify(raw)}`);
  return sid.split(';')[0] as string;
}

const baseConfig = (provider: 'fake' | 'none') =>
  loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: ctx.url,
    SESSION_SECRET: 'integration-test-session-secret-0123456789',
    APP_ORIGIN,
    MODEL_PROVIDER: provider,
    OLLAMA_CHAT_MODEL: 'gemma4:latest',
  });

const register = async (email: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: WRITE_HEADERS,
    payload: { email, password: PASSWORD, displayName: email },
  });
  expect(res.statusCode).toBe(201);
  return sessionCookie(res);
};

/**
 * `null` means "send no cookie". It is not `undefined`, because a default parameter fires
 * on `undefined` and the anonymous case would quietly become an authenticated one — which
 * is exactly the bug a 401 test exists to catch.
 */
const chat = (payload: unknown, auth: string | null = cookie, target = app) =>
  target.inject({
    method: 'POST',
    url: '/api/v1/model/chat',
    headers: auth ? { ...WRITE_HEADERS, cookie: auth } : WRITE_HEADERS,
    payload,
  });

beforeAll(async () => {
  ctx = await setupTestDb();
  app = await buildApp({
    config: baseConfig('fake'),
    db: ctx.db,
    rateLimits: false,
    checks: { checkDb: async () => ({ ok: true }) },
  });
  await app.ready();
  noModelApp = await buildApp({
    config: baseConfig('none'),
    db: ctx.db,
    rateLimits: false,
    checks: { checkDb: async () => ({ ok: true }) },
  });
  await noModelApp.ready();

  cookie = await register('model@example.test');
  otherCookie = await register('other@example.test');
});

afterAll(async () => {
  await app?.close();
  await noModelApp?.close();
  await ctx?.teardown();
});

describe('authentication and availability', () => {
  it('401s /model/chat and /model/runs without a session', async () => {
    const res = await chat({ messages: [{ role: 'user', content: 'hi' }] }, null);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');

    const runs = await app.inject({ method: 'GET', url: '/api/v1/model/runs' });
    expect(runs.statusCode).toBe(401);
  });

  it('serves /model/health unauthenticated, without leaking the base URL', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/model/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ provider: 'fake', ok: true, model: 'gemma4:latest' });
    expect(res.body).not.toContain('11434');
    expect(res.body).not.toContain('localhost');
  });

  it('reports ok:false on a deployment with no provider', async () => {
    const res = await noModelApp.inject({ method: 'GET', url: '/api/v1/model/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: 'none', ok: false, models: [] });
  });

  it('503s /model/chat with MODEL_UNAVAILABLE when MODEL_PROVIDER=none', async () => {
    const res = await chat({ messages: [{ role: 'user', content: 'hi' }] }, cookie, noModelApp);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('MODEL_UNAVAILABLE');
    expect(res.json().error.message).toMatch(/locally/i);
  });

  it('rejects think + format before it reaches the provider', async () => {
    const res = await chat({
      messages: [{ role: 'user', content: 'dates' }],
      format: DATES_SCHEMA,
      options: { think: true, scenario: 'structured-valid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('a plain prompt call', () => {
  it('writes one run with a model_call step, a final step and correct rollups', async () => {
    const res = await chat({
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'What is a system prompt?' },
      ],
      options: { scenario: 'plain-answer', temperature: 0.2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('fake');
    expect(body.model).toBe('gemma4:latest');
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.structuredOutput).toBeUndefined();

    const [run] = await ctx.sql`select * from agent_runs where id = ${body.runId}`;
    expect(run).toMatchObject({
      kind: 'prompt',
      provider: 'fake',
      model: 'gemma4:latest',
      status: 'completed',
      system_prompt: 'You are concise.',
      user_prompt: 'What is a system prompt?',
      iteration_count: 1,
      tool_call_count: 0,
      tool_parse_failure_count: 0,
    });
    expect(run?.prompt_tokens_total).toBe(body.usage.promptTokens);
    expect(run?.completion_tokens_total).toBe(body.usage.completionTokens);
    expect(run?.model_latency_ms_total).toBe(body.latencyMs);
    expect(run?.final_output).toBe(body.message.content);
    expect(run?.finished_at).not.toBeNull();
    expect(run?.request_id).toBeTruthy();
    expect(run?.options).toMatchObject({ scenario: 'plain-answer', temperature: 0.2 });

    const steps =
      await ctx.sql`select * from agent_run_steps where run_id = ${body.runId} order by step_index`;
    expect(steps.map((step) => step.kind)).toEqual(['model_call', 'final']);
    expect(steps[0]).toMatchObject({ step_index: 0, iteration: 1, is_error: false });
    expect(steps[0]?.prompt_tokens).toBe(body.usage.promptTokens);
    // providerMeta is kept: this is what the trace viewer and the SRE page read.
    expect(steps[0]?.raw).toMatchObject({ provider: 'fake', scenario: 'plain-answer' });
    expect(steps[1]?.content).toBe(body.message.content);
  });

  it('links the run to an exercise when one is given', async () => {
    const exerciseId = contentId.exercise('prompting', 'prompt-playground');
    const res = await chat({
      messages: [{ role: 'user', content: 'hi' }],
      exerciseId,
      options: { scenario: 'echo' },
    });
    expect(res.statusCode).toBe(200);
    const [run] = await ctx.sql`select exercise_id from agent_runs where id = ${res.json().runId}`;
    expect(run?.exercise_id).toBe(exerciseId);
  });

  it('records a failed call as a run with an error step and an error code', async () => {
    const res = await chat({
      messages: [{ role: 'user', content: 'hi' }],
      options: { scenario: 'error-timeout' },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('MODEL_TIMEOUT');

    const [run] = await ctx.sql`
      select * from agent_runs where user_id = (select id from users where email = 'model@example.test')
      order by started_at desc limit 1`;
    expect(run).toMatchObject({ status: 'failed', error_code: 'MODEL_TIMEOUT' });
    const steps = await ctx.sql`select * from agent_run_steps where run_id = ${run?.id as string}`;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'error', is_error: true });
  });
});

describe('structured output', () => {
  it('validates server-side and records one model_call when it works first time', async () => {
    const res = await chat({
      messages: [{ role: 'user', content: 'Extract every date.' }],
      format: DATES_SCHEMA,
      options: { scenario: 'structured-valid' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.structuredOutput).toMatchObject({ valid: true, retried: false });
    expect(body.structuredOutput.value.dates).toHaveLength(3);

    const [run] = await ctx.sql`select * from agent_runs where id = ${body.runId}`;
    expect(run).toMatchObject({ kind: 'structured', iteration_count: 1 });
    const steps =
      await ctx.sql`select kind from agent_run_steps where run_id = ${body.runId} order by step_index`;
    expect(steps.map((step) => step.kind)).toEqual(['model_call', 'final']);
  });

  it('retries once and writes two model_call steps', async () => {
    const res = await chat({
      messages: [{ role: 'user', content: 'Extract every date.' }],
      format: DATES_SCHEMA,
      options: { scenario: 'structured-retry-ok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.structuredOutput).toMatchObject({ valid: true, retried: true });

    const steps =
      await ctx.sql`select * from agent_run_steps where run_id = ${body.runId} order by step_index`;
    expect(steps.map((step) => step.kind)).toEqual(['model_call', 'model_call', 'final']);
    expect(steps[0]?.iteration).toBe(1);
    expect(steps[1]?.iteration).toBe(2);

    const [run] = await ctx.sql`select * from agent_runs where id = ${body.runId}`;
    // Both attempts are counted: a retry that "worked" still cost two calls.
    expect(run?.iteration_count).toBe(2);
    expect(Number(run?.model_latency_ms_total)).toBe(
      Number(steps[0]?.latency_ms) + Number(steps[1]?.latency_ms),
    );
  });

  it('reports the validation error verbatim when the retry also fails', async () => {
    const res = await chat({
      messages: [{ role: 'user', content: 'Extract every date.' }],
      format: DATES_SCHEMA,
      options: { scenario: 'structured-invalid' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.structuredOutput).toMatchObject({ valid: false, retried: true });
    expect(body.structuredOutput.error).toMatch(/not valid JSON/);
    expect(body.structuredOutput.value).toBeUndefined();
    // The call itself succeeded, so the run is `completed` with an invalid payload —
    // "the model answered, and the answer was the wrong shape" is not a 500.
    const [run] = await ctx.sql`select status from agent_runs where id = ${body.runId}`;
    expect(run?.status).toBe('completed');
  });
});

describe('tool calls in the trace', () => {
  it('counts a malformed tool call as a parse failure in the rollups', async () => {
    const res = await chat({
      messages: [{ role: 'user', content: 'multiply' }],
      tools: [
        {
          name: 'calculator',
          description: 'Evaluate an arithmetic expression.',
          parameters: { type: 'object', properties: { expression: { type: 'string' } } },
        },
      ],
      options: { scenario: 'tool-call-malformed-args' },
    });
    expect(res.statusCode).toBe(200);
    const [run] = await ctx.sql`select * from agent_runs where id = ${res.json().runId}`;
    expect(run).toMatchObject({ tool_call_count: 1, tool_parse_failure_count: 1 });
    expect(run?.tools).toHaveLength(1);
  });
});

describe('reading runs back', () => {
  it('lists my runs newest first and paginates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/model/runs?limit=2',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(2);
    expect(new Date(body.runs[0].startedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(body.runs[1].startedAt).getTime(),
    );
    expect(body.nextCursor).not.toBeNull();
  });

  it('returns a run with its ordered steps', async () => {
    const created = await chat({
      messages: [{ role: 'user', content: 'hello there' }],
      options: { scenario: 'echo' },
    });
    const { runId } = created.json();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/model/runs/${runId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(runId);
    expect(body.userPrompt).toBe('hello there');
    expect(body.steps.map((step: { stepIndex: number }) => step.stepIndex)).toEqual([0, 1]);
    expect(body.steps[1].content).toBe('hello there');
  });

  it('404s another user’s run rather than 403ing it', async () => {
    const created = await chat({
      messages: [{ role: 'user', content: 'mine' }],
      options: { scenario: 'echo' },
    });
    const { runId } = created.json();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/model/runs/${runId}`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');

    // And it is absent from their listing, not merely unreadable.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/model/runs',
      headers: { cookie: otherCookie },
    });
    expect(list.json().runs.map((run: { id: string }) => run.id)).not.toContain(runId);
  });

  it('refuses to append to a run owned by someone else', async () => {
    const created = await chat({
      messages: [{ role: 'user', content: 'mine' }],
      options: { scenario: 'echo' },
    });
    const res = await chat(
      { messages: [{ role: 'user', content: 'hi' }], runId: created.json().runId },
      otherCookie,
    );
    expect(res.statusCode).toBe(404);
  });

  it('appends to my own open run instead of creating a new one', async () => {
    const created = await chat({
      messages: [{ role: 'user', content: 'first' }],
      options: { scenario: 'echo' },
    });
    const { runId } = created.json();

    const appended = await chat({
      messages: [{ role: 'user', content: 'second' }],
      runId,
      options: { scenario: 'echo' },
    });
    expect(appended.statusCode).toBe(200);
    expect(appended.json().runId).toBe(runId);

    const steps =
      await ctx.sql`select kind, step_index from agent_run_steps where run_id = ${runId} order by step_index`;
    // The original model_call + final, then one more model_call. No second `final`:
    // the run the caller owns is theirs to finish.
    expect(steps.map((step) => step.kind)).toEqual(['model_call', 'final', 'model_call']);
    const [run] = await ctx.sql`select iteration_count from agent_runs where id = ${runId}`;
    expect(run?.iteration_count).toBe(2);
  });
});

describe('rate limiting', () => {
  it('429s after the per-user budget is spent', async () => {
    const limited = await buildApp({
      config: baseConfig('fake'),
      db: ctx.db,
      rateLimits: true,
      checks: { checkDb: async () => ({ ok: true }) },
    });
    await limited.ready();
    try {
      let last = 200;
      // 21 calls against a budget of 20.
      for (let i = 0; i < 21; i += 1) {
        const res = await chat(
          { messages: [{ role: 'user', content: `call ${i}` }], options: { scenario: 'echo' } },
          cookie,
          limited,
        );
        last = res.statusCode;
        if (res.statusCode === 429) {
          expect(res.json().error.code).toBe('RATE_LIMITED');
          expect(res.headers['retry-after']).toBeDefined();
          break;
        }
      }
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
