import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * `POST /model/runs` and everything hanging off it, against a real Postgres and
 * `MODEL_PROVIDER=fake`.
 *
 * These tests are about the things a unit test cannot reach: that the loop's steps land
 * in `agent_run_steps` with the right indices, that the rollup columns on `agent_runs`
 * add up, that the SSE stream replays and terminates, that `Last-Event-ID` resumes
 * without duplicating a row, that cancel really cancels, that the concurrency semaphore
 * answers 409, and that none of it is readable by another account.
 *
 * `app.inject()` drives the SSE route as happily as any other: the stream terminates
 * itself when the run ends, so the injected response resolves with the complete body.
 * That is why every run here uses a scenario that finishes.
 */

const APP_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };

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

interface CreateRunBody {
  kind?: 'agent' | 'harness';
  systemPrompt?: string;
  userPrompt?: string;
  tools?: { catalog?: string[]; mock?: unknown[] };
  maxIterations?: number;
  options?: Record<string, unknown>;
}

const postRun = (body: CreateRunBody, auth: string | null = cookie, target = app) =>
  target.inject({
    method: 'POST',
    url: '/api/v1/model/runs',
    headers: auth ? { ...WRITE_HEADERS, cookie: auth } : WRITE_HEADERS,
    payload: { userPrompt: 'Do the thing.', kind: 'agent', ...body },
  });

/**
 * Start a run, retrying briefly on 409 RUN_IN_PROGRESS.
 *
 * The concurrency slot is released in the background loop's `finally`, which runs a tick
 * *after* the terminal status is written. So a caller that polls until the run is no
 * longer `running` and then immediately starts the next one can legitimately arrive
 * while the previous slot is still held. That window is real for the UI too -- clicking
 * "run again" the instant a run finishes can 409 -- so the honest fix is for the caller
 * to retry rather than for the test to pretend the race does not exist.
 *
 * Without this the failure was intermittent *and* misleading: `createRun` did not check
 * its status code, so a 409 surfaced as an undefined `runId` and a 404 three lines later.
 */
const createRun = async (body: CreateRunBody, auth: string | null = cookie, target = app) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const res = await postRun(body, auth, target);
    const isSlotConflict =
      res.statusCode === 409 &&
      (res.json() as { error?: { code?: string } })?.error?.code === 'RUN_IN_PROGRESS';
    if (!isSlotConflict || Date.now() > deadline) return res;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const getRun = (id: string, auth: string = cookie) =>
  app.inject({ method: 'GET', url: `/api/v1/model/runs/${id}`, headers: { cookie: auth } });

/** Polls until the run reaches a terminal status. The loop runs in the background. */
async function waitForRun(id: string, auth: string = cookie): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const res = await getRun(id, auth);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (body.status !== 'running') return body;
    if (Date.now() > deadline) throw new Error(`run ${id} never finished: ${body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A minimal SSE parser: enough to assert on ids, event names and payloads. */
interface SseFrame {
  id?: number;
  event: string;
  data: unknown;
}

function parseSse(body: string): { frames: SseFrame[]; comments: string[] } {
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  for (const block of body.split('\n\n')) {
    if (block.trim() === '') continue;
    if (block.startsWith(':')) {
      comments.push(block.slice(1).trim());
      continue;
    }
    let id: number | undefined;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = Number(line.slice(4));
      else if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    frames.push({
      ...(id === undefined ? {} : { id }),
      event,
      data: JSON.parse(data.join('\n')),
    });
  }
  return { frames, comments };
}

const events = (id: string, headers: Record<string, string> = {}, auth: string = cookie) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/model/runs/${id}/events`,
    headers: { cookie: auth, ...headers },
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

  cookie = await register('agent@example.test');
  otherCookie = await register('intruder@example.test');
});

afterAll(async () => {
  await app?.close();
  await noModelApp?.close();
  await ctx?.teardown();
});

// --------------------------------------------------------------------- creating ----

describe('POST /model/runs', () => {
  it('401s without a session and 503s on a deployment with no model', async () => {
    expect((await createRun({}, null)).statusCode).toBe(401);
    const none = await createRun({}, cookie, noModelApp);
    expect(none.statusCode).toBe(503);
    expect(none.json().error.code).toBe('MODEL_UNAVAILABLE');
  });

  it('writes the run, the steps and the rollups the loop produced', async () => {
    const created = await createRun({
      systemPrompt: 'You are careful.',
      userPrompt: 'Multiply 12345 by 6789.',
      tools: { catalog: ['calculator'] },
      maxIterations: 4,
      options: { scenario: 'tool-call-once' },
    });
    expect(created.statusCode).toBe(202);
    const { runId } = created.json();

    const run = await waitForRun(runId);
    expect(run).toMatchObject({
      kind: 'agent',
      provider: 'fake',
      status: 'completed',
      iterationCount: 2,
      toolCallCount: 1,
      toolParseFailureCount: 0,
      maxIterations: 4,
    });
    expect(run.finalOutput).toMatch(/83,810,205/);

    const [row] = await ctx.sql`select * from agent_runs where id = ${runId}`;
    expect(row?.finished_at).not.toBeNull();
    expect(row?.request_id).toBeTruthy();
    // `agent_runs.tools` stores the definitions the model saw, not the request's names.
    expect(row?.tools).toMatchObject([{ name: 'calculator' }]);
    expect((row?.tools as { parameters: unknown }[])[0]?.parameters).toMatchObject({
      type: 'object',
    });
    expect(row?.prompt_tokens_total).toBeGreaterThan(0);
    expect(row?.model_latency_ms_total).toBe(84);

    const steps =
      await ctx.sql`select * from agent_run_steps where run_id = ${runId} order by step_index`;
    expect(steps.map((step) => step.kind)).toEqual([
      'model_call',
      'tool_call',
      'tool_result',
      'model_call',
      'final',
    ]);
    expect(steps.map((step) => step.step_index)).toEqual([0, 1, 2, 3, 4]);
    expect(steps[1]).toMatchObject({ tool_name: 'calculator', parse_ok: true });
    expect(steps[2]?.tool_result).toMatchObject({ result: 83810205 });
  });

  it('records a max-iterations run as its own status rather than a failure', async () => {
    const created = await createRun({
      tools: { catalog: ['calculator'] },
      maxIterations: 2,
      options: { scenario: 'tool-call-never-stops' },
    });
    const run = await waitForRun(created.json().runId);
    expect(run).toMatchObject({
      status: 'max_iterations',
      errorCode: 'MAX_ITERATIONS',
      iterationCount: 2,
      toolCallCount: 2,
    });
  });

  it('leaves an inspectable trace when the provider fails mid-run', async () => {
    const created = await createRun({ options: { scenario: 'error-unavailable' } });
    const run = await waitForRun(created.json().runId);
    expect(run).toMatchObject({ status: 'failed', errorCode: 'MODEL_UNAVAILABLE' });
    expect((run.steps as { kind: string }[]).map((step) => step.kind)).toEqual(['error']);
  });

  it('executes a learner-defined mock tool by looking its answer up', async () => {
    const created = await createRun({
      userPrompt: 'Where is order A-1001?',
      tools: {
        catalog: [],
        mock: [
          {
            name: 'get_order_status',
            description: 'Look up a customer order by id.',
            parameters: {
              type: 'object',
              properties: { order_id: { type: 'string' } },
              required: ['order_id'],
            },
            response: { status: 'unknown' },
            responses: [{ when: { order_id: 'A-1001' }, response: { status: 'shipped' } }],
          },
        ],
      },
      options: { scenario: 'tool-call-mock' },
    });
    const run = await waitForRun(created.json().runId);
    expect(run.status).toBe('completed');
    const steps = run.steps as { kind: string; toolName: string | null; toolResult: unknown }[];
    const result = steps.find((step) => step.kind === 'tool_result');
    expect(result).toMatchObject({
      toolName: 'get_order_status',
      toolResult: { status: 'shipped' },
    });
  });

  it('rejects a tool name that is not in the allow-list', async () => {
    const res = await createRun({ tools: { catalog: ['rm_rf'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a mock tool that shadows a catalog tool', async () => {
    const res = await createRun({
      tools: {
        catalog: ['calculator'],
        mock: [
          {
            name: 'calculator',
            description: 'mine',
            parameters: { type: 'object', properties: {} },
            response: {},
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/duplicate tool name/);
  });

  it('rejects maxIterations above the hard cap', async () => {
    expect((await createRun({ maxIterations: 16 })).statusCode).toBe(400);
  });

  it('opens a harness run without running anything', async () => {
    const created = await createRun({ kind: 'harness', options: { scenario: 'plain-answer' } });
    expect(created.statusCode).toBe(202);
    const run = (await getRun(created.json().runId)).json();
    expect(run).toMatchObject({ kind: 'harness', status: 'running', iterationCount: 0 });
    expect(run.steps).toEqual([]);
  });
});

// ------------------------------------------------------------------- concurrency ----

describe('the one-run-per-user semaphore', () => {
  it('returns 409 RUN_IN_PROGRESS while a run is live, then frees the slot', async () => {
    const first = await createRun({ options: { scenario: 'slow:600' } });
    expect(first.statusCode).toBe(202);

    const second = await postRun({ options: { scenario: 'plain-answer' } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('RUN_IN_PROGRESS');
    expect(second.json().error.details.runId).toBe(first.json().runId);

    // Another user is unaffected: the limit is per account, not per instance.
    const theirs = await createRun({ options: { scenario: 'plain-answer' } }, otherCookie);
    expect(theirs.statusCode).toBe(202);

    await waitForRun(first.json().runId);
    const third = await createRun({ options: { scenario: 'plain-answer' } });
    expect(third.statusCode).toBe(202);
    // Drained before the next test: the slot is per user and these tests share one.
    await waitForRun(third.json().runId);
    await waitForRun(theirs.json().runId, otherCookie);
  });

  it('does not hold the slot for a harness run', async () => {
    const harness = await createRun({ kind: 'harness' });
    expect(harness.statusCode).toBe(202);
    const agent = await createRun({ options: { scenario: 'plain-answer' } });
    expect(agent.statusCode).toBe(202);
    await waitForRun(agent.json().runId);
  });
});

// -------------------------------------------------------------------------- SSE ----

describe('GET /model/runs/:id/events', () => {
  let runId: string;

  beforeAll(async () => {
    const created = await createRun({
      tools: { catalog: ['calculator'] },
      options: { scenario: 'tool-call-once' },
    });
    runId = created.json().runId;
    await waitForRun(runId);
  });

  it('replays every step in order and terminates with an end event', async () => {
    const res = await events(runId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-transform/);

    const { frames } = parseSse(res.body);
    const steps = frames.filter((frame) => frame.event === 'step');
    expect(steps.map((frame) => frame.id)).toEqual([0, 1, 2, 3, 4]);
    expect(steps.map((frame) => (frame.data as { kind: string }).kind)).toEqual([
      'model_call',
      'tool_call',
      'tool_result',
      'model_call',
      'final',
    ]);

    const last = frames[frames.length - 1];
    expect(last?.event).toBe('end');
    expect(last?.data).toMatchObject({ id: runId, status: 'completed' });
    // The end event carries no id, so a reconnect after it still resumes from the last
    // *step* rather than skipping one.
    expect(last?.id).toBeUndefined();
  });

  it('resumes from Last-Event-ID without repeating a step', async () => {
    const res = await events(runId, { 'last-event-id': '2' });
    const { frames } = parseSse(res.body);
    const steps = frames.filter((frame) => frame.event === 'step');
    expect(steps.map((frame) => frame.id)).toEqual([3, 4]);
    expect(frames[frames.length - 1]?.event).toBe('end');
  });

  it('accepts the same cursor as a query parameter, for clients that cannot set headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/model/runs/${runId}/events?lastEventId=3`,
      headers: { cookie },
    });
    const steps = parseSse(res.body).frames.filter((frame) => frame.event === 'step');
    expect(steps.map((frame) => frame.id)).toEqual([4]);
  });

  it('streams a run that is still going, in order, and ends when it does', async () => {
    const created = await createRun({
      tools: { catalog: ['calculator'] },
      options: { scenario: 'tool-call-once' },
    });
    const liveId = created.json().runId;
    const res = await events(liveId);
    const { frames } = parseSse(res.body);
    const steps = frames.filter((frame) => frame.event === 'step');
    // Whether the stream caught the run live or replayed it after the fact, the trace
    // the client receives is identical and contains every step exactly once.
    expect(steps.map((frame) => frame.id)).toEqual([0, 1, 2, 3, 4]);
    expect(frames[frames.length - 1]?.event).toBe('end');
    await waitForRun(liveId);
  });

  /**
   * The regression CI found and a laptop never did. The duplicate-suppression check used
   * to live in the buffer-drain loop, so a step published through the live subscription
   * skipped it and the client received `[0, 1, 1, 2, 3, 4]`. Timing-dependent, so this
   * runs the race repeatedly rather than once: a single green pass proves nothing here.
   */
  it('never sends the same step twice, however the replay and the live stream interleave', async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const created = await createRun({
        tools: { catalog: ['calculator'] },
        options: { scenario: 'tool-call-once' },
      });
      const id = created.json().runId;
      const steps = parseSse((await events(id)).body).frames.filter((f) => f.event === 'step');
      const ids = steps.map((f) => f.id);

      expect(ids, `attempt ${attempt} delivered a duplicate`).toEqual([...new Set(ids)]);
      // Strictly increasing, which is what makes the id usable as a resume cursor.
      expect(ids).toEqual([...ids].sort((a, b) => Number(a) - Number(b)));
      await waitForRun(id);
    }
  });
  it('404s someone else s run rather than 403ing it', async () => {
    const res = await events(runId, {}, otherCookie);
    expect(res.statusCode).toBe(404);
  });
});

// ----------------------------------------------------------------------- cancel ----

describe('POST /model/runs/:id/cancel', () => {
  it('cancels a running agent run and the loop settles as cancelled', async () => {
    const created = await createRun({ options: { scenario: 'slow:3000' } });
    const runId = created.json().runId;

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/model/runs/${runId}/cancel`,
      headers: { ...WRITE_HEADERS, cookie },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ runId, status: 'cancelled' });

    const run = await waitForRun(runId);
    expect(run.status).toBe('cancelled');
    expect(run.errorCode).toBe('RUN_CANCELLED');
    // The slot is released, so the learner can immediately start another run.
    const next = await createRun({ options: { scenario: 'plain-answer' } });
    expect(next.statusCode).toBe(202);
    await waitForRun(next.json().runId);
  });

  it('is idempotent on a finished run and reports its real status', async () => {
    const created = await createRun({ options: { scenario: 'plain-answer' } });
    const runId = created.json().runId;
    await waitForRun(runId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/model/runs/${runId}/cancel`,
      headers: { ...WRITE_HEADERS, cookie },
    });
    // Not "cancelled": overwriting a real answer would make the trace lie.
    expect(res.json()).toMatchObject({ status: 'completed' });
  });

  it('404s someone else s run', async () => {
    const created = await createRun({ kind: 'harness' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/model/runs/${created.json().runId}/cancel`,
      headers: { ...WRITE_HEADERS, cookie: otherCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ------------------------------------------------------- client-reported steps ----

describe('POST /model/runs/:id/steps', () => {
  const report = (id: string, steps: unknown[], auth: string = cookie) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/model/runs/${id}/steps`,
      headers: { ...WRITE_HEADERS, cookie: auth },
      payload: { steps },
    });

  const openHarness = async (): Promise<string> => {
    const created = await createRun({ kind: 'harness' });
    return created.json().runId as string;
  };

  it('appends steps to a harness run, keeps the indices monotonic and rolls up', async () => {
    const runId = await openHarness();
    const first = await report(runId, [
      {
        kind: 'model_call',
        iteration: 1,
        content: 'thinking',
        latencyMs: 120,
        promptTokens: 30,
        completionTokens: 5,
      },
      {
        kind: 'tool_call',
        iteration: 1,
        toolName: 'calculator',
        toolArgs: { expression: '1+1' },
        parseOk: true,
      },
    ]);
    expect(first.statusCode).toBe(201);
    expect(first.json().steps.map((step: { stepIndex: number }) => step.stepIndex)).toEqual([0, 1]);

    const second = await report(runId, [
      {
        kind: 'tool_result',
        iteration: 1,
        toolName: 'calculator',
        toolResult: { result: 2 },
        latencyMs: 3,
      },
      { kind: 'final', iteration: 2, content: 'It is 2.' },
    ]);
    expect(second.json().steps.map((step: { stepIndex: number }) => step.stepIndex)).toEqual([
      2, 3,
    ]);

    const run = (await getRun(runId)).json();
    // A `final` step closes the run; otherwise the trace would never terminate and its
    // SSE stream would hang forever.
    expect(run).toMatchObject({
      status: 'completed',
      finalOutput: 'It is 2.',
      iterationCount: 1,
      toolCallCount: 1,
      promptTokensTotal: 30,
      modelLatencyMsTotal: 120,
    });
    expect((run.steps as { kind: string }[]).map((step) => step.kind)).toEqual([
      'model_call',
      'tool_call',
      'tool_result',
      'final',
    ]);
  });

  it('refuses a run of kind agent: that trace belongs to the server loop', async () => {
    const created = await createRun({ options: { scenario: 'plain-answer' } });
    const runId = created.json().runId;
    await waitForRun(runId);
    const res = await report(runId, [{ kind: 'final', iteration: 1, content: 'mine now' }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RUN_KIND_MISMATCH');
  });

  it('refuses a finished run', async () => {
    const runId = await openHarness();
    await report(runId, [{ kind: 'final', iteration: 1, content: 'done' }]);
    const res = await report(runId, [{ kind: 'final', iteration: 2, content: 'again' }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RUN_NOT_RUNNING');
  });

  it('404s a run owned by someone else', async () => {
    const runId = await openHarness();
    const res = await report(runId, [{ kind: 'final', iteration: 1, content: 'x' }], otherCookie);
    expect(res.statusCode).toBe(404);
    // And nothing was written.
    const rows = await ctx.sql`select count(*) from agent_run_steps where run_id = ${runId}`;
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('rejects too many steps and oversized ones', async () => {
    const runId = await openHarness();
    const many = Array.from({ length: 21 }, (_unused, index) => ({
      kind: 'model_call',
      iteration: 1,
      content: `step ${index}`,
    }));
    expect((await report(runId, many)).statusCode).toBe(400);

    const huge = [{ kind: 'model_call', iteration: 1, content: 'x'.repeat(30_000) }];
    expect((await report(runId, huge)).statusCode).toBe(400);

    // Just over the 8 KB per-step ceiling, via a field the content limit does not cover.
    const fat = [
      { kind: 'tool_result', iteration: 1, toolName: 't', toolResult: { blob: 'y'.repeat(9000) } },
    ];
    expect((await report(runId, fat)).statusCode).toBe(400);

    expect((await report(runId, [])).statusCode).toBe(400);
  });
});

// ------------------------------------------------- the M11 harness round trip ----

/**
 * The whole path Module 6's Web Worker drives, from this side of the wire.
 *
 * Neither half is new — `POST /model/chat` with a `runId` and `POST /runs/:id/steps` are
 * both already tested above — but the *interleaving* is, and it is the thing that would
 * break silently. The browser loop and the server each write into the same trace, from
 * two different requests, and the contract is that they take turns: the server owns the
 * `model_call` rows (it measured the latency and the tokens), the client owns the tool
 * rows and the `final`. A change that made either side write the other's rows would
 * double the numbers in `agent_runs` and nothing here would fail unless this test
 * existed.
 */
describe('a harness run driven from the browser', () => {
  const CALCULATOR = {
    name: 'calculator',
    description: 'Evaluate an arithmetic expression exactly.',
    parameters: { type: 'object', properties: { expression: { type: 'string' } } },
  };

  const chat = (runId: string, iteration: number, messages: unknown[]) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/model/chat',
      headers: { ...WRITE_HEADERS, cookie },
      payload: {
        messages,
        tools: [CALCULATOR],
        runId,
        // The browser's loop counter. Without it every appended `model_call` row would
        // be stamped iteration 1 while the tool rows around it were numbered correctly,
        // and the trace viewer groups by iteration.
        iteration,
        options: { scenario: 'tool-call-once' },
      },
    });

  const report = (runId: string, steps: unknown[]) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/model/runs/${runId}/steps`,
      headers: { ...WRITE_HEADERS, cookie },
      payload: { steps },
    });

  it('interleaves server model_call rows with client tool rows and closes on final', async () => {
    const created = await createRun({
      kind: 'harness',
      userPrompt: 'What is 12345 * 6789?',
    });
    expect(created.statusCode).toBe(202);
    const runId = created.json().runId as string;

    // Iteration 1: the worker asks the page to call the model; the server logs the call.
    const first = await chat(runId, 1, [{ role: 'user', content: 'What is 12345 * 6789?' }]);
    expect(first.statusCode).toBe(200);
    const calls = first.json().message.toolCalls as { name: string; args: unknown }[];
    expect(calls).toHaveLength(1);
    // The response reuses the run rather than opening a second one.
    expect(first.json().runId).toBe(runId);

    // The learner's loop executes the tool in the browser and reports both rows.
    const reported = await report(runId, [
      {
        kind: 'tool_call',
        iteration: 1,
        toolName: 'calculator',
        toolArgs: calls[0]?.args,
        parseOk: true,
      },
      {
        kind: 'tool_result',
        iteration: 1,
        toolName: 'calculator',
        toolResult: { expression: '12345 * 6789', result: 83810205 },
        latencyMs: 1,
      },
    ]);
    expect(reported.statusCode).toBe(201);
    expect(reported.json().steps.map((step: { stepIndex: number }) => step.stepIndex)).toEqual([
      1, 2,
    ]);

    // Iteration 2: the transcript now carries the tool message, so the fake finishes.
    const second = await chat(runId, 2, [
      { role: 'user', content: 'What is 12345 * 6789?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: calls.map((call, index) => ({
          id: `call_${index + 1}`,
          name: call.name,
          args: call.args,
          parseOk: true,
        })),
      },
      {
        role: 'tool',
        toolName: 'calculator',
        content: '{"expression":"12345 * 6789","result":83810205}',
      },
    ]);
    const finalText = second.json().message.content as string;
    expect(second.json().message.toolCalls ?? []).toHaveLength(0);

    const closed = await report(runId, [{ kind: 'final', iteration: 2, content: finalText }]);
    expect(closed.statusCode).toBe(201);

    const run = (await getRun(runId)).json();
    expect(
      (run.steps as { kind: string; iteration: number }[]).map(
        (step) => `${step.kind}@${step.iteration}`,
      ),
    ).toEqual(['model_call@1', 'tool_call@1', 'tool_result@1', 'model_call@2', 'final@2']);
    expect(run).toMatchObject({
      kind: 'harness',
      status: 'completed',
      finalOutput: finalText,
      // Two chat calls, each accumulating one iteration. The client reported no
      // `model_call` rows, which is what keeps this 2 rather than 4.
      iterationCount: 2,
      // Exactly one, and the number that makes this assertion worth writing: the model
      // requested one tool call (which `/model/chat` sees) and the browser reported
      // executing one (which `/steps` sees). They are the same call, so only the side
      // that writes the `tool_call` row counts it.
      toolCallCount: 1,
      toolParseFailureCount: 0,
    });
    expect(run.modelLatencyMsTotal).toBeGreaterThanOrEqual(0);
    const toolRows = (run.steps as { kind: string }[]).filter((step) => step.kind === 'tool_call');
    expect(toolRows).toHaveLength(run.toolCallCount);

    // Reported rows are tagged, so a trace always says who wrote each line.
    const clientRows = (run.steps as { kind: string; raw: unknown }[]).filter(
      (step) => step.kind !== 'model_call',
    );
    expect(
      clientRows.every((step) => (step.raw as { reportedBy?: string })?.reportedBy === 'client'),
    ).toBe(true);
  });

  it('leaves the run open until a final step arrives', async () => {
    const created = await createRun({ kind: 'harness' });
    const runId = created.json().runId as string;
    await report(runId, [{ kind: 'tool_call', iteration: 1, toolName: 'calculator' }]);
    expect((await getRun(runId)).json().status).toBe('running');

    // Which is why the page cancels a run whose loop crashed: otherwise it sits at
    // `running` for ever and its SSE stream never terminates.
    await app.inject({
      method: 'POST',
      url: `/api/v1/model/runs/${runId}/cancel`,
      headers: { ...WRITE_HEADERS, cookie },
    });
    expect((await getRun(runId)).json().status).toBe('cancelled');
  });
});

// ------------------------------------------------------------- listing and scope ----

describe('listing and ownership', () => {
  it('lists my runs newest first, and never anyone else s', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/model/runs?limit=50',
      headers: { cookie },
    });
    expect(mine.statusCode).toBe(200);
    const runs = mine.json().runs as { id: string; kind: string; startedAt: string }[];
    expect(runs.length).toBeGreaterThan(3);
    const timestamps = runs.map((run) => Date.parse(run.startedAt));
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/v1/model/runs?limit=50',
      headers: { cookie: otherCookie },
    });
    const theirIds = new Set((theirs.json().runs as { id: string }[]).map((run) => run.id));
    expect(runs.some((run) => theirIds.has(run.id))).toBe(false);
  });

  it('404s a detail read of someone else s run', async () => {
    const created = await createRun({ kind: 'harness' });
    expect((await getRun(created.json().runId, otherCookie)).statusCode).toBe(404);
  });
});

describe('GET /model/tools', () => {
  it('serves the catalog with descriptions and JSON schemas', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/model/tools',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const tools = res.json().tools as { name: string; parameters: { type: string } }[];
    expect(tools.map((tool) => tool.name)).toContain('calculator');
    expect(tools.every((tool) => tool.parameters.type === 'object')).toBe(true);
  });

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/model/tools' })).statusCode).toBe(401);
  });
});
