import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * The structured model-path log lines `docs/05-quality-and-ops.md` has always specified
 * and nothing ever emitted (M16; action item 6 of
 * `docs/postmortems/2026-09-20-ollama-down-mid-run.md`).
 *
 * The postmortem's finding B is the thing this file exists to keep fixed: grepping every
 * API log from a real incident for `runId`, `stepIndex`, `latencyMs` or `toolName`
 * returned **zero matches**, because the only model-path log statements were exception
 * handlers and a handled `MODEL_UNAVAILABLE` never reaches one. Loki and Promtail ran
 * for the whole incident with nothing to aggregate.
 *
 * Three properties are asserted, and only the first is about field names:
 *
 *  1. **The lines exist, with the fields docs/05 names.** Per model call, per tool call
 *     and result, and per run terminal state.
 *  2. **Levels carry meaning.** A failed run is an outage, not a defect: `warn`. `error`
 *     stays for genuine bugs, so a log query for `level>=50` keeps meaning "something is
 *     wrong with the code".
 *  3. **No prompt or completion text at `info`.** docs/05 is explicit that prompts live
 *     in the database. The same run at `debug` is checked to *contain* them, because a
 *     redaction test that never proves the text was available is only testing that the
 *     text was not there.
 *
 * The app is built with a captured pino stream. `NODE_ENV=test` normally disables the
 * logger entirely, and `buildApp`'s `logger` option is the documented escape hatch for
 * exactly this.
 */

const APP_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };

/**
 * Distinctive enough that "the prompt did not leak" is a real search.
 *
 * `plain-answer` would match half the fixture data and `hello` would match anything, so
 * these follow the convention `startup-log.test.ts` established for the same reason.
 */
const SYSTEM_PROMPT = 'SYSTEM-PROMPT-THAT-MUST-NOT-REACH-THE-LOG-aaaa';
const USER_PROMPT = 'USER-PROMPT-THAT-MUST-NOT-REACH-THE-LOG-bbbb';

interface LogLine {
  level: number;
  msg?: string;
  event?: string;
  reqId?: string;
  [key: string]: unknown;
}

let ctx: TestDb;
let lines: string[] = [];
let app: FastifyInstance;
let cookie: string;

/** pino writes one JSON object per line; anything else in the stream is a bug. */
const parsed = (): LogLine[] =>
  lines
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogLine);

const eventsNamed = (name: string): LogLine[] => parsed().filter((line) => line.event === name);

function sessionCookie(res: InjectResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const sid = list.find((entry) => entry.startsWith('sid='));
  if (!sid) throw new Error(`No sid cookie in response: ${JSON.stringify(raw)}`);
  return sid.split(';')[0] as string;
}

const buildLoggingApp = async (level: 'info' | 'debug'): Promise<FastifyInstance> => {
  const instance = await buildApp({
    config: loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: ctx.url,
      SESSION_SECRET: 'integration-test-session-secret-0123456789',
      APP_ORIGIN,
      MODEL_PROVIDER: 'fake',
      OLLAMA_CHAT_MODEL: 'gemma4:latest',
    }),
    db: ctx.db,
    rateLimits: false,
    checks: { checkDb: async () => ({ ok: true }) },
    logger: {
      level,
      stream: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    },
  });
  await instance.ready();
  return instance;
};

const createRun = (body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/model/runs',
    headers: { ...WRITE_HEADERS, cookie },
    payload: { kind: 'agent', systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, ...body },
  });

const getRun = (id: string) =>
  app.inject({ method: 'GET', url: `/api/v1/model/runs/${id}`, headers: { cookie } });

async function runToCompletion(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const created = await createRun(body);
  expect(created.statusCode).toBe(202);
  const runId = created.json().runId as string;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const run = (await getRun(runId)).json();
    if (run.status !== 'running') return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} never finished`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  ctx = await setupTestDb();
  app = await buildLoggingApp('info');
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: WRITE_HEADERS,
    payload: { email: 'logs@example.test', password: PASSWORD, displayName: 'logs' },
  });
  expect(registered.statusCode).toBe(201);
  cookie = sessionCookie(registered);
});

afterAll(async () => {
  await app?.close();
  await ctx?.teardown();
});

// --------------------------------------------------------------- a good run ----

describe('a successful agent run', () => {
  let run: Record<string, unknown>;

  beforeAll(async () => {
    lines = [];
    run = await runToCompletion({
      tools: { catalog: ['calculator'] },
      options: { scenario: 'tool-call-once' },
    });
    expect(run.status).toBe('completed');
  });

  it('writes one model_call line per model call, with the fields docs/05 names', () => {
    const calls = eventsNamed('model_call');
    expect(calls.length).toBe(run.iterationCount);

    const first = calls[0] as LogLine;
    // Every field in the docs/05 list for a model call, present and populated.
    expect(first).toMatchObject({
      level: 30,
      event: 'model_call',
      runId: run.id,
      provider: 'fake',
      model: 'gemma4:latest',
      outcome: 'success',
      errorCode: null,
    });
    expect(typeof first.reqId).toBe('string');
    expect(typeof first.userId).toBe('string');
    expect(typeof first.stepIndex).toBe('number');
    expect(typeof first.iteration).toBe('number');
    expect(typeof first.latencyMs).toBe('number');
    expect(typeof first.promptTokens).toBe('number');
    expect(typeof first.completionTokens).toBe('number');
  });

  it('names the step it wrote, so the line lands on a row rather than near one', async () => {
    const steps = (
      await ctx.sql`select step_index, kind from agent_run_steps where run_id = ${run.id} order by step_index`
    ).map((row) => ({ stepIndex: row.step_index, kind: row.kind }));

    for (const event of ['model_call', 'tool_call', 'tool_result']) {
      for (const line of eventsNamed(event)) {
        expect(steps).toContainEqual({ stepIndex: line.stepIndex, kind: event });
      }
    }
  });

  it('writes a tool_call and a tool_result line for the tool the loop ran', () => {
    expect(eventsNamed('tool_call')[0]).toMatchObject({
      level: 30,
      event: 'tool_call',
      runId: run.id,
      toolName: 'calculator',
      parseOk: true,
      recovered: false,
    });
    expect(eventsNamed('tool_result')[0]).toMatchObject({
      level: 30,
      event: 'tool_result',
      runId: run.id,
      toolName: 'calculator',
      isError: false,
      errorCode: null,
    });
    expect(typeof eventsNamed('tool_result')[0]?.latencyMs).toBe('number');
  });

  it('writes one run_finished line carrying the rollup the run row carries', () => {
    const finished = eventsNamed('run_finished');
    expect(finished).toHaveLength(1);
    // The same numbers as `agent_runs`, because they come from the same object. Two
    // instrumentation paths that compute a total separately eventually disagree, and
    // then the operator has to guess which of their dashboards is lying.
    expect(finished[0]).toMatchObject({
      level: 30,
      event: 'run_finished',
      runId: run.id,
      kind: 'agent',
      status: 'completed',
      errorCode: null,
      iterations: run.iterationCount,
      toolCalls: run.toolCallCount,
      parseFailures: run.toolParseFailureCount,
      promptTokens: run.promptTokensTotal,
      completionTokens: run.completionTokensTotal,
      latencyMs: run.modelLatencyMsTotal,
    });
  });

  it('carries the request id exactly once, and it is the run row`s request_id', async () => {
    const [row] = await ctx.sql`select request_id from agent_runs where id = ${run.id}`;
    const requestId = row?.request_id as string;
    expect(requestId).toBeTruthy();

    const modelCall = eventsNamed('model_call')[0] as LogLine;
    expect(modelCall.reqId).toBe(requestId);

    // Not just "present after JSON.parse": pino emits a *duplicate* JSON key when a
    // child binding and a log object both carry one, and `JSON.parse` silently keeps
    // the last. A line with two reqId fields is a line a log query cannot be trusted
    // on, so the raw text is what gets counted.
    const raw = lines
      .join('')
      .split('\n')
      .find((line) => line.includes('"event":"model_call"')) as string;
    expect(raw.match(/"reqId":/g)).toHaveLength(1);
    // `userId` is the same story: `auth/guards.ts` binds it onto the request logger
    // once the session resolves, so the payloads must not carry it either. The first
    // capture of these lines during M16 had two of them.
    expect(raw.match(/"userId":/g)).toHaveLength(1);
  });

  it('logs nothing at error: nothing here is a bug in this process', () => {
    expect(parsed().filter((line) => line.level >= 50)).toEqual([]);
  });
});

// ----------------------------------------------------------- a failing run ----

describe('a run the provider killed', () => {
  let run: Record<string, unknown>;

  beforeAll(async () => {
    lines = [];
    run = await runToCompletion({ options: { scenario: 'error-unavailable' } });
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('MODEL_UNAVAILABLE');
  });

  it('logs the handled failure that used to produce no line at all', () => {
    // This is finding B of the postmortem, inverted into an assertion. The failure is
    // *handled* — no exception escapes — which is exactly why the three pre-existing
    // exception handlers never fired and the incident produced zero model-path lines.
    const call = eventsNamed('model_call')[0] as LogLine;
    expect(call).toMatchObject({
      event: 'model_call',
      runId: run.id,
      outcome: 'unavailable',
      errorCode: 'MODEL_UNAVAILABLE',
    });
    expect(typeof call.stepIndex).toBe('number');
  });

  it('logs it at warn, not error: a dead provider is an outage, not a defect', () => {
    expect(eventsNamed('model_call')[0]?.level).toBe(40);
    expect(eventsNamed('run_finished')[0]).toMatchObject({
      level: 40,
      status: 'failed',
      errorCode: 'MODEL_UNAVAILABLE',
    });
    // The distinction is only worth having if `error` stays clean.
    expect(parsed().filter((line) => line.level >= 50)).toEqual([]);
  });
});

// ------------------------------------------------- the parse/schema distinction ----

describe('the ADR 0002 distinction survives into the log fields', () => {
  it('parseOk:false means the provider emitted malformed JSON', async () => {
    lines = [];
    const run = await runToCompletion({
      tools: { catalog: ['calculator'] },
      options: { scenario: 'tool-call-malformed-args' },
    });

    expect(eventsNamed('tool_call')[0]).toMatchObject({
      level: 40,
      parseOk: false,
      toolName: 'calculator',
    });
    // The run row agrees, exactly: every `parseOk:false` line is one increment of
    // `tool_parse_failure_count`, and there are no others. (This scenario never
    // recovers, so the loop runs to its iteration cap and there is more than one.)
    const malformed = eventsNamed('tool_call').filter((line) => line.parseOk === false);
    expect(malformed.length).toBeGreaterThan(0);
    expect(run.toolParseFailureCount).toBe(malformed.length);
  });

  it('arguments that parse and then fail the schema are a tool error, never parseOk:false', async () => {
    lines = [];
    const run = await runToCompletion({
      tools: { catalog: ['calculator'] },
      options: { scenario: 'tool-call-invalid-args' },
    });

    // The whole of docs/adr/0002 §2 in two assertions: the call parsed…
    expect(eventsNamed('tool_call')[0]).toMatchObject({ parseOk: true, level: 30 });
    // …and the failure is on the result line, with its own code.
    expect(eventsNamed('tool_result')[0]).toMatchObject({
      level: 40,
      isError: true,
      errorCode: 'INVALID_ARGUMENTS',
    });
    // Blurring the two would make this counter — and the metric it feeds — unactionable.
    expect(run.toolParseFailureCount).toBe(0);
  });

  it('a tool that throws is a tool error too, with the tool`s own code', async () => {
    lines = [];
    await runToCompletion({
      tools: { catalog: ['flaky_service'] },
      options: { scenario: 'tool-call-throws' },
    });
    const result = eventsNamed('tool_result')[0] as LogLine;
    expect(result.level).toBe(40);
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBeTruthy();
    expect(result.errorCode).not.toBe('INVALID_ARGUMENTS');
  });
});

// ------------------------------------------------------------- no prompts ----

describe('prompts never reach the log at info', () => {
  it('emits neither the system prompt nor the user prompt anywhere in the run`s lines', async () => {
    lines = [];
    const run = await runToCompletion({
      tools: { catalog: ['calculator'] },
      options: { scenario: 'tool-call-once' },
    });
    const whole = lines.join('');

    // docs/05: "Never log prompt contents at `info` (they're in the DB)". Searched
    // across every line the run produced, not only the model_call ones — the point is
    // that the text is not in the log, wherever it came from.
    expect(whole).not.toContain(SYSTEM_PROMPT);
    expect(whole).not.toContain(USER_PROMPT);
    // The completion is content too, and it is on the same footing.
    expect(whole).not.toContain(run.finalOutput as string);

    // And the text really is recoverable — from the database, where docs/05 puts it.
    const [row] =
      await ctx.sql`select system_prompt, user_prompt from agent_runs where id = ${run.id}`;
    expect(row?.system_prompt).toBe(SYSTEM_PROMPT);
    expect(row?.user_prompt).toBe(USER_PROMPT);
  });

  it('does include them at debug, which is what makes the info assertion mean something', async () => {
    const debugApp = await buildLoggingApp('debug');
    const previous = app;
    app = debugApp;
    lines = [];
    try {
      await runToCompletion({ options: { scenario: 'plain-answer' } });
      const whole = lines.join('');
      expect(whole).toContain(SYSTEM_PROMPT);
      expect(whole).toContain(USER_PROMPT);
      // On its own line, at debug, and never merged into the info-level one.
      const content = eventsNamed('model_call_content');
      expect(content.length).toBeGreaterThan(0);
      expect(content[0]?.level).toBe(20);
      expect(eventsNamed('model_call').every((line) => line.level === 30)).toBe(true);
    } finally {
      app = previous;
      await debugApp.close();
    }
  });
});

// --------------------------------------------- the client-reported harness path ----

describe('steps the browser reported', () => {
  it('logs them with reportedBy:client, so an operator can tell whose loop failed', async () => {
    lines = [];
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/model/runs',
      headers: { ...WRITE_HEADERS, cookie },
      payload: {
        kind: 'harness',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: USER_PROMPT,
      },
    });
    const runId = created.json().runId as string;

    const reported = await app.inject({
      method: 'POST',
      url: `/api/v1/model/runs/${runId}/steps`,
      headers: { ...WRITE_HEADERS, cookie },
      payload: {
        steps: [
          {
            clientStepId: 'a',
            kind: 'tool_call',
            iteration: 1,
            toolName: 'calculator',
            toolArgs: { expression: '1+1' },
            parseOk: true,
          },
          {
            clientStepId: 'b',
            kind: 'tool_result',
            iteration: 1,
            toolName: 'calculator',
            toolResult: { result: 2 },
            latencyMs: 3,
          },
          { clientStepId: 'c', kind: 'final', iteration: 1, content: 'It is 2.' },
        ],
      },
    });
    expect(reported.statusCode).toBe(201);

    expect(eventsNamed('tool_call')[0]).toMatchObject({
      runId,
      toolName: 'calculator',
      reportedBy: 'client',
    });
    expect(eventsNamed('tool_result')[0]).toMatchObject({ runId, reportedBy: 'client' });
    expect(eventsNamed('run_finished')[0]).toMatchObject({
      runId,
      kind: 'harness',
      status: 'completed',
      level: 30,
    });
  });

  it('writes nothing extra for a replay, because nothing extra happened', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/model/runs',
      headers: { ...WRITE_HEADERS, cookie },
      payload: { kind: 'harness', systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT },
    });
    const runId = created.json().runId as string;
    const body = {
      steps: [
        {
          clientStepId: 'only-once',
          kind: 'tool_call',
          iteration: 1,
          toolName: 'calculator',
          toolArgs: { expression: '2+2' },
          parseOk: true,
        },
      ],
    };
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/model/runs/${runId}/steps`,
        headers: { ...WRITE_HEADERS, cookie },
        payload: body,
      });

    await post();
    lines = [];
    await post();
    // A duplicated log line is a duplicated step as far as anyone reading a dashboard
    // built on log counts is concerned.
    expect(eventsNamed('tool_call').filter((line) => line.runId === runId)).toEqual([]);
  });
});
