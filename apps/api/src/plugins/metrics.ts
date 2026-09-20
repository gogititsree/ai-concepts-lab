import { timingSafeEqual } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
  type Metric,
} from 'prom-client';

import { AppError } from '../lib/errors.js';

/**
 * Prometheus metrics (M14) — the exact table in `docs/05-quality-and-ops.md`.
 *
 * ## Why the bucket boundaries are what they are
 *
 * Histogram buckets are the one part of an instrumentation layer you cannot fix
 * retroactively: a value that lands in `+Inf` is gone, and `histogram_quantile` over a
 * series where 100 % of observations are in the overflow bucket returns the *last finite
 * boundary*, silently, forever. prom-client's defaults top out at **10 seconds**. On this
 * machine a warm model call takes 6–45 s and a cold one 20–70 s (`docs/spike-notes.md`:
 * M0 measured 12.6–43.8 s across five identical calls; M9 measured a 32.3 s cold plain
 * chat; M10 measured a 23.5 s first call and a 71.2 s first call with six tools attached).
 * With the default buckets the p95 of every model call in this app would read "10 s" and
 * the 30-second SLO would look permanently met. So every histogram below is dimensioned
 * from a measurement, and each one says which.
 *
 * ## Label cardinality
 *
 * Route labels are the Fastify **route pattern** (`/api/v1/lessons/:id`), never the
 * resolved URL, and unmatched requests collapse to the literal string `unmatched`.
 * A metric labelled with resolved URLs is a memory leak with a dashboard attached: one
 * series per lesson id, forever, and Prometheus keeps them after they stop being written.
 *
 * ## Why a module-level singleton
 *
 * prom-client throws on registering the same metric name twice, and the integration suite
 * builds several Fastify apps in one process. Metrics are a property of the *process*, not
 * of a Fastify instance, so they are created once, lazily, on a private `Registry`
 * (not the global default one — a stray import elsewhere must not be able to add to it).
 */

// ------------------------------------------------------------------- buckets ----

/**
 * Model calls, in seconds. Measured, not guessed:
 *  - 0.1 / 0.25 — the `fake` provider (sub-millisecond) and CI, so the metric is not one
 *    giant first bucket when the suite generates the traffic.
 *  - 1 … 18 — the warm band. M10's second-call latencies were 7.9–8.1 s and the M0 five-run
 *    sample had three calls between 12 and 15 s, so this is where the resolution belongs.
 *  - **30 — the SLO boundary itself** (`docs/05`: model p95 < 30 s). A bucket edge exactly
 *    on the threshold means the SLO can be read as a ratio of two counters
 *    (`..._bucket{le="30"} / ..._count`) instead of interpolated out of a quantile, which
 *    is both cheaper and the only statistically honest way to evaluate it.
 *  - 45 / 60 / 90 — the cold-load and six-tools tail (M10: 71.2 s). 90 is `MODEL_TIMEOUT_MS`:
 *    the last finite bucket must be at the timeout, or every timed-out call lands in
 *    `+Inf` and the tail disappears exactly when it matters.
 */
export const MODEL_CALL_BUCKETS = [0.1, 0.25, 1, 2, 5, 8, 12, 18, 25, 30, 45, 60, 90];

/**
 * HTTP requests, in seconds. The SLO is p95 < 800 ms for non-model routes, so 0.8 is a
 * boundary for the same reason 30 is above. The 3/10/30/90 tail exists because
 * `POST /model/chat` is on this histogram too and is a 6–45 s request by design; without
 * it that route would be 100 % overflow and its `+Inf`-only series would drag the eye.
 */
export const HTTP_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 0.8, 1.5, 3, 10, 30, 90];

/**
 * Tool execution, in seconds. M10 and M11 measured **2–9 ms** for every tool in the
 * catalog, so the resolution is at the millisecond end where the data actually is. The
 * 10 s boundary is `TOOL_TIMEOUT_MS`: a tool that hits it must be visible as a bucket, not
 * as overflow.
 */
export const TOOL_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1, 5, 10];

/** Iterations per run. Fixed by `docs/05-quality-and-ops.md`; 15 is `AGENT_MAX_ITERATIONS_CAP`. */
export const ITERATION_BUCKETS = [1, 2, 3, 5, 8, 15];

/** Database queries, in seconds. Local Postgres answers the SLI aggregation in 1–20 ms. */
export const DB_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5];

// -------------------------------------------------------------- the registry ----

export interface LabMetrics {
  registry: Registry;
  httpRequestDuration: Histogram<'route' | 'method' | 'status'>;
  modelCallDuration: Histogram<'provider' | 'model' | 'outcome'>;
  modelCallErrors: Counter<'provider' | 'code'>;
  toolCallParseFailures: Counter<'tool' | 'recovered'>;
  toolExecutionDuration: Histogram<'tool' | 'outcome'>;
  agentRunIterations: Histogram<'kind'>;
  agentRunsTotal: Counter<'kind' | 'status'>;
  structuredOutputRetries: Counter<'outcome'>;
  modelProviderUp: Gauge<'provider'>;
  dbPoolWaiting: Gauge<string>;
  dbQueryDuration: Histogram<'query'>;
  sessionsActive: Gauge<string>;
}

let singleton: LabMetrics | null = null;

function build(): LabMetrics {
  const registry = new Registry();
  // Process-level metrics (heap, event-loop lag, GC, fds). Free, and the first thing
  // anyone asks for when a free-tier instance starts behaving oddly.
  collectDefaultMetrics({ register: registry });

  const register = <T extends Metric>(metric: T): T => {
    registry.registerMetric(metric);
    return metric;
  };

  return {
    registry,

    httpRequestDuration: register(
      new Histogram({
        name: 'http_request_duration_seconds',
        help: 'HTTP request duration by route pattern, method and status',
        labelNames: ['route', 'method', 'status'] as const,
        buckets: HTTP_BUCKETS,
      }),
    ),

    modelCallDuration: register(
      new Histogram({
        name: 'model_call_duration_seconds',
        help: 'One provider.chat() call, measured by the adapter rather than reported by the model',
        labelNames: ['provider', 'model', 'outcome'] as const,
        buckets: MODEL_CALL_BUCKETS,
      }),
    ),

    modelCallErrors: register(
      new Counter({
        name: 'model_call_errors_total',
        help: 'Failed model calls by provider and error class (timeout/unavailable/http/parse)',
        labelNames: ['provider', 'code'] as const,
      }),
    ),

    toolCallParseFailures: register(
      new Counter({
        name: 'tool_call_parse_failures_total',
        help:
          'Tool calls whose arguments the provider could not hand back as JSON. ' +
          'Provider-side only: arguments that parse but fail the tool schema are a ' +
          'different bug and are not counted here (docs/adr/0002). ' +
          'recovered="true" means the call was dug out of prose by the fenced-JSON fallback.',
        labelNames: ['tool', 'recovered'] as const,
      }),
    ),

    toolExecutionDuration: register(
      new Histogram({
        name: 'tool_execution_duration_seconds',
        help: 'Tool execution time, excluding inference',
        labelNames: ['tool', 'outcome'] as const,
        buckets: TOOL_BUCKETS,
      }),
    ),

    agentRunIterations: register(
      new Histogram({
        name: 'agent_run_iterations',
        help: 'Iterations per finished run. Read the distribution, never the mean: mass at the cap is runaway loops.',
        labelNames: ['kind'] as const,
        buckets: ITERATION_BUCKETS,
      }),
    ),

    agentRunsTotal: register(
      new Counter({
        name: 'agent_runs_total',
        help: 'Finished runs by kind and terminal status (completed/failed/cancelled/max_iterations)',
        labelNames: ['kind', 'status'] as const,
      }),
    ),

    structuredOutputRetries: register(
      new Counter({
        name: 'structured_output_retries_total',
        help:
          'Retries of a structured-output call after the first attempt failed validation ' +
          '(decision 16 in docs/07-open-decisions.md). outcome="recovered" when the retry ' +
          'validated, "exhausted" when it did not.',
        labelNames: ['outcome'] as const,
      }),
    ),

    modelProviderUp: register(
      new Gauge({
        name: 'model_provider_up',
        help: '1 when the configured model provider answers its liveness probe with the chat model present',
        labelNames: ['provider'] as const,
      }),
    ),

    dbPoolWaiting: register(
      new Gauge({
        name: 'db_pool_waiting',
        help: 'Instrumented queries waiting for a free connection (in-flight minus pool size)',
      }),
    ),

    dbQueryDuration: register(
      new Histogram({
        name: 'db_query_duration_seconds',
        help: 'Duration of instrumented database queries, by query name',
        labelNames: ['query'] as const,
        buckets: DB_BUCKETS,
      }),
    ),

    sessionsActive: register(
      new Gauge({
        name: 'sessions_active',
        help: 'Sessions that are neither revoked nor expired',
      }),
    ),
  };
}

/** The process's metrics. Built on first use so importing this file costs nothing. */
export function getMetrics(): LabMetrics {
  singleton ??= build();
  return singleton;
}

/** Zeroes every value, keeping the definitions. For tests that assert on counts. */
export function resetMetrics(): void {
  singleton?.registry.resetMetrics();
}

// ------------------------------------------------------- emit helpers (M14) ----
//
// The instrumentation points in `model/` call these rather than reaching for the
// registry, so an emit site is one line and the label vocabulary is decided here.

/** Maps an `AppError.code` onto the small, stable label set docs/05 names. */
export function modelErrorClass(code: string): string {
  switch (code) {
    case 'MODEL_TIMEOUT':
      return 'timeout';
    case 'MODEL_UNAVAILABLE':
      return 'unavailable';
    case 'REQUEST_ABORTED':
      return 'aborted';
    case 'VALIDATION_FAILED':
      return 'parse';
    default:
      return 'http';
  }
}

export interface ModelCallObservation {
  provider: string;
  model: string;
  /** `success`, or the error class from `modelErrorClass`. */
  outcome: string;
  durationMs: number;
}

/**
 * One model call. Also nudges `model_provider_up`, because a call that just succeeded (or
 * just got ECONNREFUSED) is fresher evidence than the scrape-time probe — during the
 * "kill Ollama mid-run" drill this is what flips the gauge inside the run rather than at
 * the next scrape.
 */
export function observeModelCall(observation: ModelCallObservation): void {
  const metrics = getMetrics();
  const { provider, model, outcome, durationMs } = observation;
  metrics.modelCallDuration.observe({ provider, model, outcome }, durationMs / 1000);
  if (outcome === 'success') {
    metrics.modelProviderUp.set({ provider }, 1);
    return;
  }
  metrics.modelCallErrors.inc({ provider, code: outcome });
  if (outcome === 'unavailable' || outcome === 'timeout') {
    metrics.modelProviderUp.set({ provider }, 0);
  }
}

/** Sets `model_provider_up{provider}` from a liveness result somebody else already has. */
export function setModelProviderUp(provider: string, up: boolean): void {
  getMetrics().modelProviderUp.set({ provider }, up ? 1 : 0);
}

export function observeToolExecution(tool: string, isError: boolean, durationMs: number): void {
  getMetrics().toolExecutionDuration.observe(
    { tool, outcome: isError ? 'error' : 'success' },
    durationMs / 1000,
  );
}

/**
 * A tool call whose arguments the *provider* could not give us as JSON.
 *
 * `recovered` distinguishes "we dug the call out of a fenced block in the prose"
 * (`ollama.ts` → `recoverToolCallsFromContent`) from "we gave up and handed the model its
 * own mistake back". Both are parse failures; only one of them produced a usable call,
 * and an operator needs to know which is rising.
 */
export function countToolParseFailure(tool: string, recovered: boolean): void {
  getMetrics().toolCallParseFailures.inc({ tool, recovered: String(recovered) });
}

export function countRunFinished(kind: string, status: string, iterations: number): void {
  const metrics = getMetrics();
  metrics.agentRunsTotal.inc({ kind, status });
  if (iterations > 0) metrics.agentRunIterations.observe({ kind }, iterations);
}

export function countStructuredRetries(retries: number, valid: boolean): void {
  if (retries <= 0) return;
  getMetrics().structuredOutputRetries.inc({ outcome: valid ? 'recovered' : 'exhausted' }, retries);
}

// ------------------------------------------------------------ db instrumentation ----

let inFlightQueries = 0;
/** Mirrors `DB_POOL_MAX`; set when the plugin registers. */
let poolMax = 5;

/**
 * Times a database query and keeps the in-flight count that `db_pool_waiting` is derived
 * from.
 *
 * **What this does not cover, honestly:** only the queries that opt in by calling it —
 * today the `/ops/sli` aggregation and the two scrape-time probes below. Wrapping *every*
 * Drizzle query would mean a hook inside `createDbClient`, and postgres.js exposes no
 * per-query duration callback (its `debug` option fires before execution), so the only
 * way in is to proxy the tagged-template handle at construction. That is a change to
 * `db/client.ts`, which this milestone does not own. See
 * `docs/adr/0006-observability-deviations.md`; the helper is exported so widening the
 * coverage later is a call-site change, not a redesign.
 */
export async function observeDbQuery<T>(name: string, work: () => Promise<T>): Promise<T> {
  const metrics = getMetrics();
  inFlightQueries += 1;
  // postgres.js queues anything beyond `max` until a connection frees up, so in-flight
  // above the pool size *is* the wait queue.
  metrics.dbPoolWaiting.set(Math.max(0, inFlightQueries - poolMax));
  const started = process.hrtime.bigint();
  try {
    return await work();
  } finally {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    metrics.dbQueryDuration.observe({ query: name }, seconds);
    inFlightQueries -= 1;
    metrics.dbPoolWaiting.set(Math.max(0, inFlightQueries - poolMax));
  }
}

// ----------------------------------------------------------------- the plugin ----

/** `/metrics` must never be in its own latency histogram: a scrape is not user traffic. */
const EXCLUDED_ROUTES = new Set(['/metrics', '/api/v1/metrics']);

/**
 * Compares the presented bearer token with the configured one in constant time.
 *
 * Exported because `/ops/sli` accepts the same token as an alternative to a session
 * (see `ops/routes.ts`): the scheduled uptime check has no cookie.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the length, so
 * both sides are hashed to a fixed width first — the standard shape for this check.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so the "wrong length" path is not measurably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value === '' ? null : value;
}

export interface MetricsPluginOptions {
  /**
   * Liveness probe behind `model_provider_up`. Defaults to the configured provider's own
   * `health()`, built through the `ModelProvider` factory — this file never mentions
   * Ollama (CLAUDE.md) and never will.
   */
  probeProvider?: () => Promise<{ name: string; ok: boolean }>;
}

/**
 * Registers the request-duration hook, the scrape-time gauges and `GET /metrics`.
 *
 * This is the single line added to `app.ts`. Everything else in M14's metric surface is
 * emitted from where the thing happens.
 */
export async function registerMetrics(
  app: FastifyInstance,
  opts: MetricsPluginOptions = {},
): Promise<void> {
  const metrics = getMetrics();
  poolMax = app.config.DB_POOL_MAX;

  // The scrape-time probe. Built once per app rather than per scrape: for `ollama` it is
  // a stateless fetch wrapper, so this costs nothing and keeps the seam intact.
  //
  // Imported dynamically rather than at the top of the file, and that is not style.
  // `model/agentLoop.ts` and `model/routes.ts` import this module for the emit helpers;
  // a static `../model/provider.js` here would make every one of them drag in both
  // adapters and the whole shared contract package to increment a counter — measured at
  // ~2 s of extra module load per test worker. The plugin is the only consumer that
  // needs a provider, and it is called exactly once per app.
  const { createProvider } = await import('../model/provider.js');
  const provider = createProvider(app.config);
  const probe =
    opts.probeProvider ??
    (async () => {
      const health = await provider.health();
      return { name: provider.name, ok: health.ok };
    });

  // `health()` is a network call (~20 ms warm, instant ECONNREFUSED when Ollama is dead).
  // Cached for a few seconds so a human curling /metrics next to a 15 s Prometheus scrape
  // does not double the probe rate, but short enough that killing Ollama shows up on the
  // next scrape rather than the one after.
  const PROBE_TTL_MS = 5_000;
  /**
   * A scrape must answer even when a dependency is hanging. Prometheus gives up after
   * its own `scrape_timeout` and records the target as down, which would say "the API is
   * unreachable" when the truth is "the database is slow" — and would lose every other
   * metric in the same breath, including the ones that explain it. So both refreshes are
   * raced against a deadline and the previous value stands if they lose.
   */
  const REFRESH_DEADLINE_MS = 2_000;
  const withDeadline = async (work: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, REFRESH_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let probedAt = 0;
  let probing: Promise<void> | null = null;

  const refreshProviderUp = async (): Promise<void> => {
    if (Date.now() - probedAt < PROBE_TTL_MS) return;
    probing ??= (async () => {
      try {
        const result = await probe();
        metrics.modelProviderUp.set({ provider: result.name }, result.ok ? 1 : 0);
      } catch {
        // `health()` is contractually non-throwing; if something got past that, an
        // unknown state is reported as down rather than crashing the scrape.
        metrics.modelProviderUp.set({ provider: app.config.MODEL_PROVIDER }, 0);
      } finally {
        probedAt = Date.now();
        probing = null;
      }
    })();
    await probing;
  };

  const refreshSessionsActive = async (): Promise<void> => {
    try {
      const rows = await observeDbQuery('sessions_active', () =>
        app.db.execute<{ count: string }>(sql`
          select count(*)::text as count
          from sessions
          where revoked_at is null and expires_at > now()
        `),
      );
      const first = (rows as unknown as { count: string }[])[0];
      if (first) metrics.sessionsActive.set(Number(first.count));
    } catch {
      // A scrape must not fail because the database blinked: the previous value stands,
      // and `up`/`db_query_duration_seconds` already say the database is unhappy.
    }
  };

  // -------------------------------------------------------- request duration ----

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    // The *pattern* (`/api/v1/lessons/:id`), never `request.url`. See the header.
    const route = request.routeOptions?.url ?? 'unmatched';
    if (EXCLUDED_ROUTES.has(route)) return;
    metrics.httpRequestDuration.observe(
      { route, method: request.method, status: String(reply.statusCode) },
      // Fastify measures this itself, from the start of the request rather than from the
      // start of the handler, so it includes the hooks and the body parse.
      reply.elapsedTime / 1000,
    );
  });

  // ------------------------------------------------------------------ /metrics ----

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const expected = app.config.METRICS_TOKEN;
    if (!expected) {
      throw new AppError(
        503,
        'METRICS_DISABLED',
        'METRICS_TOKEN is not configured, so /metrics is closed. Set it to enable scraping.',
      );
    }
    const presented = bearer(request);
    if (!presented || !tokenMatches(presented, expected)) {
      // 401 with a challenge, not 403: the caller *may* authenticate, it just has not.
      reply.header('www-authenticate', 'Bearer realm="metrics"');
      throw new AppError(401, 'UNAUTHENTICATED', 'A bearer METRICS_TOKEN is required');
    }

    await withDeadline(Promise.all([refreshProviderUp(), refreshSessionsActive()]).then(() => {}));
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  };

  // Root `/metrics` is what every Prometheus scrape config assumes by default; the
  // `/api/v1` alias is the spelling in the docs/01 route table. One handler, two paths,
  // so neither the convention nor the document is wrong.
  app.get('/metrics', handler);
  app.get('/api/v1/metrics', handler);
}
