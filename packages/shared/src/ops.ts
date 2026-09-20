import { z } from 'zod';

/**
 * `GET /api/v1/ops/sli` — the service-level indicators the in-app `/ops` page renders
 * (M14, `docs/05-quality-and-ops.md` → "Traces in the DB").
 *
 * The whole point of this contract is that it is computed from `agent_runs` and
 * `agent_run_steps` in Postgres rather than from Prometheus: the app can answer "is it
 * working, and how well" with **no external monitoring stack attached**. Prometheus and
 * Grafana exist in parallel for alerting and for the local learning stack; if they are
 * not running, this endpoint is still correct.
 *
 * Every rate in here is nullable rather than zero. "No runs yet" and "0 % success" are
 * completely different situations and a new learner sees the first one all the time; a
 * schema that could not tell them apart would put a red 0 % on an empty dashboard.
 */

/** The window selector the `/ops` page offers, in hours: 1 h, 24 h, 7 d. */
export const SLI_WINDOW_HOURS = [1, 24, 168] as const;

/**
 * `?hours=` — 1 hour minimum, 30 days maximum. The ceiling is not arbitrary: the SLO
 * windows in `docs/slo.md` are 7 and 30 days, and a window longer than the longest SLO
 * is a question nobody has.
 */
export const SliQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
});

export const SliStatusCountsSchema = z.object({
  running: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  maxIterations: z.number().int(),
});

/**
 * One row per tool that was called in the window.
 *
 * `parseFailures` counts **provider-side** failures only — arguments that were not JSON
 * at all. Arguments that parsed but failed the tool's Zod schema are a different bug with
 * a different fix and are counted in `errors` instead. That split is
 * `docs/adr/0002-agent-tooling-deviations.md` §2 and it is the reason this shape has two
 * numbers rather than one.
 */
export const SliToolStatSchema = z.object({
  tool: z.string(),
  calls: z.number().int(),
  parseFailures: z.number().int(),
  /** `tool_result` steps with `is_error` — unknown tool, bad arguments, tool threw. */
  errors: z.number().int(),
  /** `parseFailures / calls`, or null when the tool was never called. */
  parseFailureRate: z.number().nullable(),
});

/**
 * One bar of the iteration histogram. `le` is the inclusive upper bound of the bucket and
 * matches the Prometheus buckets on `agent_run_iterations` (1, 2, 3, 5, 8, 15); `le: null`
 * is the `+Inf` overflow.
 *
 * **`count` is the number of runs in this bucket, not cumulative.** Prometheus histograms
 * are cumulative and this deliberately is not: the page draws a distribution, and the
 * shape of the distribution is the thing Module 5 lesson 4 tells learners to read.
 */
export const SliIterationBucketSchema = z.object({
  le: z.number().int().nullable(),
  count: z.number().int(),
});

export const SliErrorCodeSchema = z.object({
  code: z.string(),
  count: z.number().int(),
});

export const SliResponseSchema = z.object({
  window: z.object({
    hours: z.number().int(),
    from: z.string(),
    to: z.string(),
  }),
  runs: z.object({
    total: z.number().int(),
    /** Runs that reached a terminal status; the denominator of every rate below. */
    terminal: z.number().int(),
    byStatus: SliStatusCountsSchema,
    /** `completed / terminal`, null when nothing has finished in the window. */
    successRate: z.number().nullable(),
    /** `(failed + max_iterations) / terminal` — the docs/05 "> 25 %" alert. */
    badOutcomeShare: z.number().nullable(),
  }),
  /**
   * Percentiles over individual `model_call` steps, not over runs: a run is several calls
   * and averaging them hides the iteration count inside the latency
   * (`content/modules/06-harnesses/lessons/04-observability-for-harnesses.md`).
   */
  modelCalls: z.object({
    count: z.number().int(),
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    maxMs: z.number().nullable(),
  }),
  tools: z.array(SliToolStatSchema),
  iterations: z.object({
    buckets: z.array(SliIterationBucketSchema),
    /** Runs counted in the histogram (terminal runs with at least one iteration). */
    total: z.number().int(),
    meanPerRun: z.number().nullable(),
  }),
  /** Most frequent `agent_runs.error_code` values in the window, worst first. */
  errorCodes: z.array(SliErrorCodeSchema),
  tokens: z.object({
    promptTotal: z.number().int(),
    completionTotal: z.number().int(),
    /** (prompt + completion) / terminal runs, null on an empty window. */
    perRunAvg: z.number().nullable(),
  }),
});

export type SliQuery = z.infer<typeof SliQuerySchema>;
export type SliStatusCounts = z.infer<typeof SliStatusCountsSchema>;
export type SliToolStat = z.infer<typeof SliToolStatSchema>;
export type SliIterationBucket = z.infer<typeof SliIterationBucketSchema>;
export type SliErrorCode = z.infer<typeof SliErrorCodeSchema>;
export type SliResponse = z.infer<typeof SliResponseSchema>;
