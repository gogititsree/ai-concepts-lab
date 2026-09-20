# ADR 0006 — Five deviations in the M14 observability work

- **Status:** accepted
- **Date:** 2026-09-19 (M14, metrics, SLOs, alerting, runbooks)
- **Deviates from:** `docs/01-architecture.md` → Ops route table; `docs/05-quality-and-ops.md`
  → the metrics table and the alerting section

The M14 brief is unusually prescriptive — `docs/05` names every metric, every label and
every alert threshold, and they are implemented as written. These five points are where
reality did not fit the document, and each one is here because the alternative was worse
rather than because it was easier.

---

## 1. `GET /metrics` is served at the root **and** under `/api/v1`

`docs/01-architecture.md`'s Ops table lists `GET /metrics` alongside `GET /health`, which
is mounted at `/api/v1/health` — so the document can be read as promising
`/api/v1/metrics`. Every Prometheus scrape config in existence, including the one in
`docker/observability/prometheus/prometheus.yml`, defaults to `/metrics` at the root.

Rather than pick one and make the other wrong, the same handler is registered at both
paths. It is two lines, both are excluded from `http_request_duration_seconds`, and the
cost of the duplication is smaller than the cost of either a surprising scrape config or
a stale sentence in the architecture doc.

## 2. `/metrics` answers **503**, not 200, when `METRICS_TOKEN` is unset

`docs/05` says "protected by `METRICS_TOKEN` bearer" and does not say what happens when
there is no token. The two candidate readings are "serve it openly" and "close it", and
they have opposite failure modes: the first means a forgotten environment variable
silently publishes a complete inventory of every route, error code and traffic volume in
the service, on a public URL, with no log line saying so.

So the endpoint fails closed, with a distinct `METRICS_DISABLED` code so the operator can
tell "you forgot to configure this" from "your token is wrong" (401). This matches the
posture `ops/maintenance.ts` (M13) already took for `MAINTENANCE_TOKEN`, and the two
tokens are deliberately separate keys — see §3.

## 3. `GET /ops/sli` accepts the `METRICS_TOKEN` bearer as well as a session

`docs/05` specifies a scheduled GitHub Actions check that reads `/ops/sli` and opens an
issue when the run success rate drops below 80 %. It writes the call as
`/ops/sli?token=`. A query-parameter token is the one option that is actually worse than
the others — it lands in access logs, in `Referer` headers and in shell history — so the
question became which credential a cookie-less workflow should hold.

Three candidates:

| Option                                    | Why not / why                                                        |
| ----------------------------------------- | -------------------------------------------------------------------- |
| A real account with a password and TOTP   | Long-lived user credentials in CI, an account with write access, and an audit trail that blames a human for a robot's request. |
| A third, SLI-only token                   | Another secret to rotate, for a strict subset of what `METRICS_TOKEN` already grants. |
| Reuse `MAINTENANCE_TOKEN` (M13)           | **No.** It deletes rows. A monitoring check must never hold a credential that can destroy the thing it monitors. |
| **Reuse `METRICS_TOKEN`**                 | Chosen. Read-only, already grants the same facts in a different shape (`agent_runs_total` and friends are on `/metrics`), and absent the variable the path does not exist at all. |

The session path is unchanged and is what the `/ops` page uses. The token is checked
first because it is a string comparison and the session guard is a database round trip.

## 4. `db_query_duration_seconds` and `db_pool_waiting` cover only instrumented queries

Both metrics exist, are exported, and carry real values — but only for queries that opt in
through `observeDbQuery()`, which today is the `/ops/sli` aggregation and the scrape-time
`sessions_active` probe. They are **not** a complete picture of the app's database traffic,
and the metric help strings and the source comment say so.

The reason is a genuine seam problem rather than a shortcut. postgres.js exposes no
per-query duration callback — its `debug` option fires *before* execution — so the only
way to time every query is to proxy the tagged-template handle where it is constructed, in
`db/client.ts`. Two things argue against doing that here: `db/client.ts` is outside this
milestone's ownership and was being changed concurrently by M13, and the proxy is not
trivial to get right (postgres.js's `Query` is a lazy thenable that drizzle mutates with
`.values()` after receiving it, so attaching an observer eagerly would execute the query
before drizzle finished describing it).

`observeDbQuery` is exported and the wrapper is one line per call site, so widening the
coverage later is a mechanical change. The honest alternative — dropping the two metrics
because they cannot be complete — would have removed `db_pool_waiting` from the docs/05
table for a reason that is fixable.

## 5. Two residual data-viz validator findings on the `/ops` status palette, accepted

The four run-outcome fills were validated with the data-viz method's checker against this
app's own surfaces. Two checks do not pass outright, in both light and dark:

- **Chroma floor on the `cancelled` slot** (`#64748b` / `#7e8ba1`). It is the de-emphasis
  slot; reading as grey is the intent. The checker flags it because it scores every slot
  as a competing categorical identity, which `cancelled` is not.
- **Adjacent CVD ΔE in the 6–8 band** (amber↔emerald light, rose↔amber dark). The method
  permits this band *only with secondary encoding*, and the stacked bar ships three: a
  2 px surface gap between segments, a legend naming every segment with its own count, and
  the same four numbers again in the outcome table. Making the pair pass outright needs
  either a lighter amber (which then fails contrast on the light surface) or a warning
  colour that is not amber, and a warning colour that does not look like a warning costs
  more comprehension than the ΔE buys.

The full validator output and the reasoning are recorded in
`apps/web/src/features/ops/palette.ts` so the next person does not have to re-derive them.

---

## Also worth recording, though not deviations

- **`GET /health` never returns `degraded` as shipped.** It maps the database probe to
  `ok`/`down` and has no `checks.model` entry, so the `degraded` state that
  `docs/01-architecture.md` describes — and that `docs/slo.md` and
  `.github/workflows/uptime.yml` are written against — cannot currently occur. Nothing
  downstream is wrong: both treat `ok` and `degraded` as good and page only on `down` or
  no answer, so adding the model check later changes no consumer. Flagged in `docs/slo.md`
  rather than fixed here, because `routes/health.ts` is not this milestone's file.
- **`model/ollama.ts` was not modified.** The milestone brief allowed instrumentation
  edits there; none were needed. Every model metric is emitted from the two call sites
  that invoke `provider.chat()` (`model/agentLoop.ts` and `model/routes.ts`), which means
  the `fake` provider is measured identically to the real one — so CI, the E2E test and
  the load generation in M14's verification all produce the same series. Instrumenting the
  adapter would have measured only Ollama.
- **`plugins/metrics.ts` imports `model/provider.js` dynamically.** Measured: a static
  import made `agentLoop.ts` and `model/routes.ts` — which import this module only for the
  emit helpers — pull in both provider adapters and the whole shared contract package,
  adding ~1.2 s of module load to every Vitest worker. The plugin is the only consumer
  that needs a provider and it runs once per app.
