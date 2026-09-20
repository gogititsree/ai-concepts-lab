import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  countRunFinished,
  countToolParseFailure,
  getMetrics,
  ITERATION_BUCKETS,
  MODEL_CALL_BUCKETS,
  modelErrorClass,
  observeModelCall,
  resetMetrics,
} from '../src/plugins/metrics.js';

/**
 * `/metrics` and the emit helpers, with no Postgres and no model.
 *
 * The three things this file is actually protecting:
 *
 *  1. **The token gate.** A metrics endpoint is a free inventory of every route, error
 *     code and traffic volume in the service. Unauthenticated by accident is the default
 *     failure mode of this feature everywhere it exists.
 *  2. **The label is the route pattern.** `/api/v1/lessons/:id`, never the resolved URL.
 *     This is the assertion that keeps the series count bounded by the route table
 *     instead of by the content table.
 *  3. **The buckets.** They were chosen from the measurements in `docs/spike-notes.md`
 *     and the SLO thresholds in `docs/05-quality-and-ops.md`; if somebody "tidies" them
 *     back to prom-client's defaults, every model call lands in `+Inf` and the latency
 *     SLI silently reads 10 s forever. A test is cheaper than that discovery.
 */

const TOKEN = 'metrics-token-for-tests-0123456789';

const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    GIT_SHA: 'test-sha',
    DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab',
    MODEL_PROVIDER: 'fake',
    METRICS_TOKEN: TOKEN,
    ...overrides,
  });

async function build(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const app = await buildApp({
    config: testConfig(overrides),
    checks: { checkDb: async () => ({ ok: true }) },
    rateLimits: false,
  });
  await app.ready();
  return app;
}

const scrape = (app: FastifyInstance, token: string | null = TOKEN) =>
  app.inject({
    method: 'GET',
    url: '/metrics',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

describe('GET /metrics', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetMetrics();
    app = await build();
  });

  afterEach(async () => {
    await app.close();
  });

  it('refuses a scrape with no bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
    // A challenge, so a caller knows *how* to authenticate rather than just that it failed.
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('refuses a scrape with the wrong token, including one of a different length', async () => {
    expect((await scrape(app, 'nope')).statusCode).toBe(401);
    expect((await scrape(app, `${TOKEN}x`)).statusCode).toBe(401);
    expect((await scrape(app, TOKEN.replace(/9$/, '8'))).statusCode).toBe(401);
  });

  it('serves Prometheus text with the default process metrics when the token matches', async () => {
    const res = await scrape(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // Default metrics prove `collectDefaultMetrics` is wired to the same registry.
    expect(res.body).toContain('process_cpu_user_seconds_total');
    expect(res.body).toContain('nodejs_eventloop_lag_seconds');
  });

  it('exposes every metric named in the docs/05 table', async () => {
    // Touch the ones that only exist once they have a labelled child, so the scrape is
    // not empty for a counter nobody has incremented yet.
    observeModelCall({
      provider: 'fake',
      model: 'gemma4:latest',
      outcome: 'success',
      durationMs: 12,
    });
    countToolParseFailure('calculator', true);
    countRunFinished('agent', 'completed', 2);
    getMetrics().sessionsActive.set(3);
    getMetrics().dbPoolWaiting.set(0);
    getMetrics().dbQueryDuration.observe({ query: 'test' }, 0.002);
    getMetrics().structuredOutputRetries.inc({ outcome: 'recovered' });
    getMetrics().toolExecutionDuration.observe({ tool: 'calculator', outcome: 'success' }, 0.003);
    getMetrics().modelCallErrors.inc({ provider: 'fake', code: 'timeout' });
    getMetrics().modelProviderUp.set({ provider: 'fake' }, 1);

    const body = (await scrape(app)).body;
    for (const name of [
      'http_request_duration_seconds',
      'model_call_duration_seconds',
      'model_call_errors_total',
      'tool_call_parse_failures_total',
      'tool_execution_duration_seconds',
      'agent_run_iterations',
      'agent_runs_total',
      'model_provider_up',
      'db_pool_waiting',
      'db_query_duration_seconds',
      'sessions_active',
      'structured_output_retries_total',
    ]) {
      expect(body, `missing ${name}`).toContain(`# TYPE ${name} `);
    }
  });

  it('is closed rather than public when METRICS_TOKEN is not configured', async () => {
    const openApp = await build({ METRICS_TOKEN: '' });
    try {
      const res = await openApp.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('METRICS_DISABLED');
    } finally {
      await openApp.close();
    }
  });

  it('is also reachable under /api/v1 so the docs/01 route table is true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# TYPE ');
  });
});

describe('http_request_duration_seconds', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetMetrics();
    app = await build();
  });

  afterEach(async () => {
    await app.close();
  });

  it('labels a parameterised route with its pattern, not the resolved URL', async () => {
    // Two different ids must produce **one** series. Unauthenticated is fine: the
    // request still matched the route, which is all the label depends on.
    await app.inject({
      method: 'GET',
      url: '/api/v1/lessons/11111111-1111-4111-8111-111111111111',
    });
    await app.inject({
      method: 'GET',
      url: '/api/v1/lessons/22222222-2222-4222-8222-222222222222',
    });

    const body = (await scrape(app)).body;
    expect(body).toContain('route="/api/v1/lessons/:id"');
    expect(body).not.toContain('11111111-1111-4111-8111-111111111111');

    const counts = body
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('http_request_duration_seconds_count') &&
          line.includes('route="/api/v1/lessons/:id"'),
      );
    expect(counts).toHaveLength(1);
    expect(counts[0]?.trim().endsWith(' 2')).toBe(true);
  });

  it('collapses an unmatched URL to a single "unmatched" series', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/no-such-route-a' });
    await app.inject({ method: 'GET', url: '/api/v1/no-such-route-b' });

    const body = (await scrape(app)).body;
    expect(body).toContain('route="unmatched"');
    expect(body).not.toContain('no-such-route-a');
  });

  it('excludes the scrape itself', async () => {
    await scrape(app);
    await scrape(app);
    const body = (await scrape(app)).body;
    expect(body).not.toContain('route="/metrics"');
    expect(body).not.toContain('route="/api/v1/metrics"');
  });
});

describe('bucket boundaries', () => {
  it('keeps the model-call histogram usable past prom-client’s 10 s default', () => {
    // The measured range is 6-45 s warm and 20-70 s cold (docs/spike-notes.md), and the
    // per-call timeout is 90 s. Both ends have to be inside the finite buckets.
    expect(Math.max(...MODEL_CALL_BUCKETS)).toBe(90);
    expect(MODEL_CALL_BUCKETS).toContain(30); // the SLO threshold, exactly
    expect(MODEL_CALL_BUCKETS.filter((b) => b > 10).length).toBeGreaterThanOrEqual(5);
  });

  it('uses the iteration buckets docs/05 specifies', () => {
    expect(ITERATION_BUCKETS).toEqual([1, 2, 3, 5, 8, 15]);
  });
});

describe('modelErrorClass', () => {
  it('maps the app error vocabulary onto the docs/05 label set', () => {
    expect(modelErrorClass('MODEL_TIMEOUT')).toBe('timeout');
    expect(modelErrorClass('MODEL_UNAVAILABLE')).toBe('unavailable');
    expect(modelErrorClass('REQUEST_ABORTED')).toBe('aborted');
    expect(modelErrorClass('INTERNAL_ERROR')).toBe('http');
  });

  it('drives model_provider_up down on an unavailable call and back up on a good one', async () => {
    resetMetrics();
    const app = await build();
    try {
      observeModelCall({
        provider: 'ollama',
        model: 'gemma4:latest',
        outcome: 'unavailable',
        durationMs: 5,
      });
      expect((await scrape(app)).body).toContain('model_provider_up{provider="ollama"} 0');

      observeModelCall({
        provider: 'ollama',
        model: 'gemma4:latest',
        outcome: 'success',
        durationMs: 8_000,
      });
      expect((await scrape(app)).body).toContain('model_provider_up{provider="ollama"} 1');
    } finally {
      await app.close();
    }
  });
});
