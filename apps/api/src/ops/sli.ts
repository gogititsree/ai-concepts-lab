import { type SliResponse } from '@lab/shared';
import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { observeDbQuery } from '../plugins/metrics.js';

/**
 * The SLI aggregation (M14) — `docs/05-quality-and-ops.md` → "Traces in the DB".
 *
 * `agent_runs` / `agent_run_steps` are this application's durable trace store, and this
 * file is the reason that matters: every number the `/ops` page shows is computed here,
 * in Postgres, from rows the app already writes. The in-app dashboard therefore works
 * with **zero external monitoring infrastructure** — no Prometheus, no Grafana, no
 * retention policy to forget to configure. Prometheus exists in parallel for alerting
 * (see `plugins/metrics.ts`); it is not a dependency of being able to answer "is it
 * working".
 *
 * ## Why this is one SQL statement and not a loop in Node
 *
 * The obvious implementation — `select * from agent_runs where started_at > $1` and do
 * the arithmetic in JavaScript — is wrong in a way that only shows up later: it moves
 * every prompt, every completion and every `raw` blob across the wire to compute eight
 * numbers, so the cost of the dashboard grows with the size of the trace table rather
 * than with the size of the answer. A run row carries the system prompt, the user prompt,
 * the tool definitions and the final output. Ten thousand of those is tens of megabytes
 * to produce one percentage.
 *
 * So: one round trip, one statement, six CTEs over the same window, and the result is a
 * single row of JSON. Postgres reads the two tables once and hands back roughly a
 * kilobyte.
 *
 * ## The scope is the service, not the caller
 *
 * These are *service*-level indicators: they aggregate every user's runs. This is a
 * single-learner teaching app (`docs/05`: "the in-app `/ops` page"), the GitHub Actions
 * uptime check reads the same endpoint to decide whether to open an incident, and a
 * per-user SLI would answer a question nobody is asking. The route still requires a
 * session — any logged-in learner — because the error codes and prompt volumes in here
 * are operational detail, not public.
 *
 * ## Percentiles
 *
 * `percentile_cont` over `agent_run_steps.latency_ms` for `kind='model_call'`, i.e. per
 * *call*, not per run. Module 6 lesson 4 is explicit about why: a run is several calls,
 * and a per-run average hides the iteration count inside the latency.
 */

/** Matches `ITERATION_BUCKETS` in `plugins/metrics.ts`; docs/05 fixes both. */
const ITERATION_BUCKETS = [1, 2, 3, 5, 8, 15] as const;

/** How many distinct `error_code` values the page shows. Long tails are for the trace viewer. */
const TOP_ERROR_CODES = 8;

/**
 * The shape Postgres hands back: one row, every field already aggregated. Numeric
 * aggregates come back as strings from `postgres.js` when they are `bigint`/`numeric`, so
 * everything is cast to text in SQL and parsed here — explicit beats "it was a number in
 * development and a string in production".
 */
interface SliRow extends Record<string, unknown> {
  total: string;
  terminal: string;
  running: string;
  completed: string;
  failed: string;
  cancelled: string;
  max_iterations: string;
  prompt_tokens: string;
  completion_tokens: string;
  iterations_sum: string;
  iterations_counted: string;
  model_call_count: string;
  p50_ms: string | null;
  p95_ms: string | null;
  max_ms: string | null;
  iteration_buckets: { le: number | null; count: number }[] | null;
  tools: { tool: string; calls: number; parse_failures: number; errors: number }[] | null;
  error_codes: { code: string; count: number }[] | null;
}

const int = (value: string | number | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const num = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * `a / b`, or null when `b` is zero.
 *
 * The null is the whole point and it is tested: an empty window must not produce `NaN`,
 * must not produce `0`, and must not divide by zero. A brand-new learner's `/ops` page is
 * the empty window, every time, and "0 % success rate" in red would be a lie told on
 * first run.
 */
const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export interface ComputeSliOptions {
  hours: number;
  /** Injectable so the integration test can pin the window against fixture timestamps. */
  now?: Date;
}

export async function computeSli(db: Db, options: ComputeSliOptions): Promise<SliResponse> {
  const hours = options.hours;
  const to = options.now ?? new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);

  const rows = await observeDbQuery('ops_sli', () =>
    db.execute<SliRow>(sql`
      -- One pass over the runs in the window; everything below reads this CTE.
      with w as (
        select *
        from agent_runs
        -- Bound as ISO text and cast, not as a JS Date: postgres.js binds a Date
        -- through drizzle's raw-SQL path as a string parameter of an inferred type and
        -- refuses it. The cast keeps the predicate sargable against
        -- agent_runs_status_started_at_idx.
        where started_at >= ${from.toISOString()}::timestamptz
          and started_at <  ${to.toISOString()}::timestamptz
      ),
      -- Status counts, token totals and the iteration sum, in one aggregate.
      totals as (
        select
          count(*)::text                                              as total,
          count(*) filter (where status <> 'running')::text            as terminal,
          count(*) filter (where status = 'running')::text             as running,
          count(*) filter (where status = 'completed')::text           as completed,
          count(*) filter (where status = 'failed')::text              as failed,
          count(*) filter (where status = 'cancelled')::text           as cancelled,
          count(*) filter (where status = 'max_iterations')::text      as max_iterations,
          coalesce(sum(prompt_tokens_total), 0)::text                  as prompt_tokens,
          coalesce(sum(completion_tokens_total), 0)::text              as completion_tokens,
          coalesce(sum(iteration_count) filter (where status <> 'running'), 0)::text
                                                                       as iterations_sum,
          count(*) filter (where status <> 'running' and iteration_count > 0)::text
                                                                       as iterations_counted
        from w
      ),
      -- Latency percentiles over individual model_call steps, not over runs.
      calls as (
        select s.latency_ms
        from agent_run_steps s
        join w on w.id = s.run_id
        where s.kind = 'model_call' and s.latency_ms is not null
      ),
      latency as (
        select
          count(*)::text                                                       as model_call_count,
          percentile_cont(0.5) within group (order by latency_ms)::text        as p50_ms,
          percentile_cont(0.95) within group (order by latency_ms)::text       as p95_ms,
          max(latency_ms)::text                                                as max_ms
        from calls
      ),
      -- The iteration distribution, bucketed exactly like the agent_run_iterations
      -- Prometheus histogram (1, 2, 3, 5, 8, 15). Written as a CASE rather than
      -- width_bucket because the boundaries are not evenly spaced and the explicit
      -- ladder is the thing a reader can check against docs/05 line by line. NULL is
      -- the +Inf overflow.
      buckets as (
        select
          case
            when iteration_count <= 1 then 1
            when iteration_count <= 2 then 2
            when iteration_count <= 3 then 3
            when iteration_count <= 5 then 5
            when iteration_count <= 8 then 8
            when iteration_count <= 15 then 15
            else null
          end as le,
          count(*)::int as count
        from w
        where status <> 'running' and iteration_count > 0
        group by 1
      ),
      bucket_json as (
        select coalesce(
          jsonb_agg(jsonb_build_object('le', le, 'count', count) order by le nulls last),
          '[]'::jsonb
        ) as iteration_buckets
        from buckets
      ),
      -- Per-tool call counts. A tool_call step is one requested call; parse_ok = false is
      -- a provider-side parse failure (docs/adr/0002). Errors are counted on the matching
      -- tool_result rows, because "the arguments failed the schema" is recorded there.
      tool_calls as (
        select
          s.tool_name                                          as tool,
          count(*) filter (where s.kind = 'tool_call')::int     as calls,
          count(*) filter (where s.kind = 'tool_call' and s.parse_ok is false)::int
                                                               as parse_failures,
          count(*) filter (where s.kind = 'tool_result' and s.is_error)::int
                                                               as errors
        from agent_run_steps s
        join w on w.id = s.run_id
        where s.tool_name is not null and s.kind in ('tool_call', 'tool_result')
        group by s.tool_name
      ),
      tool_json as (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'tool', tool, 'calls', calls,
              'parse_failures', parse_failures, 'errors', errors
            )
            order by parse_failures desc, calls desc, tool
          ) filter (where calls > 0),
          '[]'::jsonb
        ) as tools
        from tool_calls
      ),
      error_json as (
        select coalesce(
          jsonb_agg(entry order by (entry->>'count')::int desc, entry->>'code'),
          '[]'::jsonb
        ) as error_codes
        from (
          select jsonb_build_object('code', error_code, 'count', count(*)::int) as entry
          from w
          where error_code is not null
          group by error_code
          order by count(*) desc, error_code
          limit ${TOP_ERROR_CODES}
        ) top_codes
      )
      select *
      from totals, latency, bucket_json, tool_json, error_json
    `),
  );

  // `db.execute` returns the driver's row array; one row is guaranteed because every CTE
  // is an aggregate over a possibly-empty set, which yields exactly one row.
  const row = (rows as unknown as SliRow[])[0];
  if (!row) throw new Error('the SLI aggregation returned no row');

  const terminal = int(row.terminal);
  const completed = int(row.completed);
  const failed = int(row.failed);
  const maxIterations = int(row.max_iterations);
  const promptTotal = int(row.prompt_tokens);
  const completionTotal = int(row.completion_tokens);
  const iterationsCounted = int(row.iterations_counted);

  // Buckets are emitted only for populated ranges; the page wants a complete axis, so the
  // missing ones are filled with zero here rather than in SQL (cheaper, and it keeps the
  // bucket list in one place in TypeScript).
  const byLe = new Map<number | null, number>(
    (row.iteration_buckets ?? []).map((bucket) => [bucket.le, int(bucket.count)]),
  );
  const buckets = [
    ...ITERATION_BUCKETS.map((le) => ({ le, count: byLe.get(le) ?? 0 })),
    { le: null, count: byLe.get(null) ?? 0 },
  ];

  return {
    window: { hours, from: from.toISOString(), to: to.toISOString() },
    runs: {
      total: int(row.total),
      terminal,
      byStatus: {
        running: int(row.running),
        completed,
        failed,
        cancelled: int(row.cancelled),
        maxIterations,
      },
      successRate: ratio(completed, terminal),
      badOutcomeShare: ratio(failed + maxIterations, terminal),
    },
    modelCalls: {
      count: int(row.model_call_count),
      p50Ms: num(row.p50_ms),
      p95Ms: num(row.p95_ms),
      maxMs: num(row.max_ms),
    },
    tools: (row.tools ?? []).map((tool) => ({
      tool: tool.tool,
      calls: int(tool.calls),
      parseFailures: int(tool.parse_failures),
      errors: int(tool.errors),
      parseFailureRate: ratio(int(tool.parse_failures), int(tool.calls)),
    })),
    iterations: {
      buckets,
      total: iterationsCounted,
      meanPerRun: ratio(int(row.iterations_sum), iterationsCounted),
    },
    errorCodes: (row.error_codes ?? []).map((entry) => ({
      code: entry.code,
      count: int(entry.count),
    })),
    tokens: {
      promptTotal,
      completionTotal,
      perRunAvg: ratio(promptTotal + completionTotal, terminal),
    },
  };
}
