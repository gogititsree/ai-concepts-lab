# Service level objectives

**Status:** adopted at M14 · **Review:** monthly · **Owner:** the one person who works on this

The four SLOs are the table in `docs/05-quality-and-ops.md`. This document says, for each
one, what exactly is measured, where the number comes from, and what happens when the
budget runs out. A target nobody can compute is a wish.

One thing to be clear about up front: this is a **solo learning project deployed on a free
tier**. The numbers below are not chosen because somebody would be paged; they are chosen
because having them makes the difference between "the app feels slow lately" and "the p95
crossed 30 s on the 14th, here is the run". Everything here exists to be *practised*.

---

## The four objectives

| #   | SLI                                              | SLO      | Window | Measured by                                       |
| --- | ------------------------------------------------ | -------- | ------ | ------------------------------------------------- |
| 1   | `/health` availability (`ok` **or** `degraded`)  | 99 %     | 30 d   | UptimeRobot + `.github/workflows/uptime.yml`      |
| 2   | Non-model API p95 latency                        | < 800 ms | 30 d   | `http_request_duration_seconds` (Prometheus)      |
| 3   | Agent run success rate when the provider is up   | ≥ 90 %   | 7 d    | `/ops/sli` → `runs.successRate`                   |
| 4   | Model call p95 latency (local)                   | < 30 s   | 7 d    | `/ops/sli` → `modelCalls.p95Ms`                   |

### 1. Availability — 99 % over 30 days

**Good event:** `GET /api/v1/health` returns HTTP 200 with a body whose `status` is `ok`
or `degraded`. **Bad event:** no response, a non-200, or `status: "down"`.

`degraded` counts as good, and that is the whole design of the endpoint. `down` means the
*database* is unreachable, which means nothing works; a missing model provider is
`degraded`, because on this deployment there is no model **on purpose** (decision 1 in
`docs/07-open-decisions.md` — the free instance runs `MODEL_PROVIDER=none` and modules 4–6
show a "run this locally" banner). An availability SLI that counted the intended
configuration as an outage would burn its entire budget on day one and teach the reader to
ignore it.

> Note (M14): as shipped, `GET /health` reports `ok` or `down` from the database probe
> only — it does not yet add a `checks.model` entry, so in practice it never returns
> `degraded`. The mapping above is the contract in `docs/01-architecture.md` and both the
> uptime workflow and this SLO are already written against it, so adding the model check
> later changes no consumer. What matters for paging is the rule "only `down` pages", and
> that holds either way.

**Error budget:** 1 % of 30 days = **7 h 12 min**. Measured against the 30-minute cron,
that is about 14 consecutive failed checks.

**Cold starts are not downtime, and the check has to know the difference.** A Render free
web service sleeps after 15 minutes of inactivity, and the first request after that waits
for the container to start — tens of seconds, on a good day. That is latency, not
unavailability: the service is doing exactly what a free tier does. The uptime check
distinguishes them in two ways:

- **A generous timeout.** `curl --max-time 60` on the health call. A cold start that
  answers in 40 s is a success; only a request that gets nothing in a minute is a failure.
- **One retry before it believes the failure.** The check curls again after 20 seconds and
  only opens an issue if *both* attempts fail. A single sleeping instance answers the
  second one.

What this deliberately gives up: the SLI cannot distinguish "warm and healthy" from "cold
but recovering", and it will not notice a service that is technically up and uniformly
awful. That is the right trade for a free tier — and objective 2 is where slowness is
supposed to show up.

### 2. Non-model API p95 < 800 ms over 30 days

**Measured by** `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{route!~".*/model/(chat|embed)"}[…])))`,
which is panel 9 of the Grafana dashboard.

Model routes are excluded, not because they are allowed to be slow by exemption but
because they are a different kind of thing: `POST /model/chat` is 6–45 seconds of local
inference by design (`docs/spike-notes.md`), and averaging it in would make this number
meaningless in both directions. Its latency is objective 4.

The `0.8` bucket boundary exists in `plugins/metrics.ts` precisely so this objective can be
evaluated as a ratio of two counters rather than as an interpolated quantile.

**Error budget:** 5 % of requests may exceed 800 ms. Note that this is measured only where
Prometheus is running, which on this project is locally — see "What is not measured" below.

### 3. Agent run success rate ≥ 90 % over 7 days

**Measured by** `GET /api/v1/ops/sli?hours=168` → `runs.successRate`, i.e.
`completed / (completed + failed + cancelled + max_iterations)` over `agent_runs`. The
same field is exported as `agent_runs_total{kind,status}` for alerting.

"When the provider is healthy" is the qualifier in `docs/05`, and it is load-bearing: a
run that failed because Ollama was not running is a provider outage (objective 1's
concern), not a defect in the loop. The SLI as implemented does **not** filter those out —
it counts every terminal run — so when reviewing this objective, read `errorCodes`
alongside it: a success rate of 60 % where every failure is `MODEL_UNAVAILABLE` has not
missed this objective, it has found a different one.

A `cancelled` run counts as a failure here even though nothing went wrong technically.
That is intentional: people cancel because the wait got intolerable, which is a real
failure of the service to be usable, just wearing a latency problem's clothes.

**Error budget:** 10 % of runs. At the volume of a solo learner (tens of runs a week) this
budget is consumed by two or three bad runs, which makes it noisy — a known limitation,
and the reason the alerting threshold is 80 % with a 10-run floor rather than 90 % with
none.

### 4. Model call p95 < 30 s over 7 days

**Measured by** `GET /api/v1/ops/sli?hours=168` → `modelCalls.p95Ms`
(`percentile_cont(0.95)` over `agent_run_steps.latency_ms` where `kind='model_call'`), and
in Prometheus by `model_call_duration_seconds`.

Per **call**, not per run: a run is several calls and a per-run number hides the iteration
count inside the latency.

This one is honestly marginal, and saying so is the point. The measured distribution on
this hardware is 6–45 s warm and 20–70 s cold; a cold load alone can put a single call
over the objective. 30 s is therefore a target that a *warm, working* setup meets
comfortably and a neglected one does not — which is the behaviour worth alerting on.

**Error budget:** 5 % of calls. The first call of a session will regularly be one of them.

---

## Error-budget policy

From `docs/05-quality-and-ops.md`, and it is one sentence:

> **If more than 50 % of the availability budget is consumed in a window, the next
> milestone is a reliability task instead of a feature.**

In practice, at each monthly review:

1. Read `/ops/sli?hours=720` and the incident issues labelled `incident`.
2. If availability burned > 3 h 36 min (half of 7 h 12 min), the next milestone is
   reliability work, chosen from the action items in the postmortems.
3. If an objective was met every month for three months, it is too loose — tighten it, or
   delete it. An objective that cannot fail measures nothing.
4. If an objective failed every month for three months and the cause is the platform
   rather than the code, change the objective and write down why. A permanently red SLO
   trains you to ignore red.

## How each objective is alerted

Alerting and objectives are deliberately different numbers. An SLO is evaluated over 7 or
30 days; an alert has to fire fast enough to act on and rarely enough to be believed.

| Objective | Alert                                                    | Where                                                    |
| --------- | -------------------------------------------------------- | -------------------------------------------------------- |
| 1         | `/health` unreachable or `down`, twice, 20 s apart        | `.github/workflows/uptime.yml` → GitHub issue `incident`  |
| 1         | same, every 5 min                                         | UptimeRobot (free) → email                                |
| 2         | p95 > 800 ms                                              | Grafana panel threshold (no rule: too noisy solo)         |
| 3         | success rate < 80 % with ≥ 10 runs                        | `.github/workflows/uptime.yml` → GitHub issue `incident`  |
| 3         | `failed` + `max_iterations` share > 25 % for 15 min       | Grafana rule → `docs/runbooks/runaway-loops.md`           |
| 4         | p95 > 30 s for 15 min                                     | Grafana rule → `docs/runbooks/slow-inference.md`          |
| —         | model error rate > 20 % for 10 min                        | Grafana rule → `docs/runbooks/model-provider-down.md`     |
| —         | parse-failure rate > 10 % over 1 h                        | Grafana rule → `docs/runbooks/parse-failure-spike.md`     |
| —         | `model_provider_up` 0 for 5 min (`provider != "none"`)    | Grafana rule → `docs/runbooks/model-provider-down.md`     |

## What is not measured, and why that is written down

- **Prometheus only runs locally.** Objective 2 is therefore measured on a laptop, not on
  the deployed instance. Running a hosted Prometheus would cost money this project does
  not spend; `/ops/sli`, which needs nothing but the database, is the deployed substitute
  and is why objectives 3 and 4 are defined against it rather than against a metric.
- **There is no client-side RUM.** "Did the page feel fast" is unmeasured.
- **The uptime cron is every 30 minutes**, so availability is sampled 48 times a day.
  A 20-minute outage between samples is invisible. UptimeRobot's 5-minute check is the
  finer grain; the cron exists for the *incident paper trail*, not for resolution.
- **`/ops/sli` needs a session**, so the GitHub Actions check cannot read it with a
  cookie. See `.github/workflows/uptime.yml` for how that is handled and what it costs.
