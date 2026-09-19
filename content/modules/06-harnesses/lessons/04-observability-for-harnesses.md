---
slug: observability-for-harnesses
title: Observability for harnesses
orderIndex: 4
estimatedMinutes: 14
---

# Observability for harnesses

An agent that fails does not usually throw. It answers, plausibly, having called the
wrong tool twice and given up on the third try — and from the outside that is
indistinguishable from an agent that worked. Ordinary HTTP monitoring says 200, the
latency is normal, the error rate is zero. This is why a harness needs its own
instrumentation, and why the thing you instrument is the **loop**, not the request.

## Log the step, not the run

The unit is the step. Every time round your loop produces one to three of them, and each
is written the moment it happens rather than buffered until the end. That second part
matters more than it sounds: a run that is killed in iteration four has iterations one to
three in the database already, and a partial trace with `status='running'` is precisely
the artefact you want for the run that went wrong. A harness that wrote its trace on
completion would have nothing to show for exactly the runs worth looking at.

The schema is `agent_run_steps`, and the fields exist because each answers a question
somebody asks at 2 a.m.:

| field                                     | the question it answers                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `kind`, `iteration`, `step_index`         | what happened, in what order, on which pass                  |
| `latency_ms`                              | was it the model or the tool? (it is always the model)       |
| `prompt_tokens`, `completion_tokens`      | what did this cost, and which part is growing                |
| `tool_name`, `tool_args`, `tool_args_raw` | what did the model actually ask for                          |
| `parse_ok`                                | was the argument text even JSON                              |
| `is_error`                                | did the tool fail — separately from whether the _run_ failed |
| `raw`                                     | whatever the provider said that we do not model              |

Your harness run writes into the same table. The tool calls your loop makes are reported
by the worker; the model calls are written by the server as it makes them, so their
latency and token counts are measured rather than reported. Open `/runs/:id` after a real
run and you are reading the same viewer, over the same rows, as a Module 5 run.

## The SLIs

These are the five numbers worth a dashboard, and they are the ones `/ops` will show when
M14 builds it. Each is here because a failure above is invisible without it.

**Model latency, p50 and p95** (`model_call_duration_seconds`). Measured per _call_, not
per run, or the iteration count hides inside it. On this machine inference is over 99.9 %
of an agent run's wall clock — tool execution measured 2–9 ms in every run — so this
metric is the latency SLI and everything else is rounding. The SLO is p95 under 30 s over
7 days.

**Tool-call parse-failure rate** (`tool_call_parse_failures_total{tool, recovered}`). The
leading indicator that a model version, a prompt or a tool schema has drifted. It is the
first thing to move when someone edits a tool's JSON Schema, and it moves before anything
a user would report. Note the app counts only _provider-side_ parse failures here —
arguments that were not JSON at all. Arguments that parse but fail the schema are a
different bug with a different fix, recorded as a `tool_result` with `is_error`
(`docs/adr/0002-agent-tooling-deviations.md` argues that split).

**Iterations per run** (`agent_run_iterations`, buckets 1, 2, 3, 5, 8, 15). Read the
distribution, never the mean. Mass piling up at the cap is runaway loops, and it will
never show up as an error because hitting the cap is a _bounded outcome_, not a crash —
which is exactly why it has its own status.

**Run success rate** (`agent_runs_total{kind, status}`). Four statuses, and keeping them
distinct is the point: `completed`, `failed`, `cancelled`, `max_iterations`. A rising
`max_iterations` share is a prompt or a tool description degrading. A rising `cancelled`
share is people giving up on the wait, which is a latency problem wearing a different
hat. Collapsing them into "errors" throws away the diagnosis and keeps only the alarm.

**Cost proxies: tokens per run**, prompt and completion counted separately. Prompt tokens
are the real driver because they are re-sent every iteration, and tool descriptions are
prompt text. The measured example from Module 5: attaching all six catalog tools instead
of the one the question needed took the first call from **227 to 1052 prompt tokens** and
from **23 s to 71 s**. Nobody wrote a slow feature; someone ticked five checkboxes.

## Two more that catch what those five miss

**Run wall clock versus `model_latency_ms_total`.** When they diverge, the time is going
somewhere other than inference, and that somewhere is a bug — a tool doing I/O it should
not, a lock, a retry loop you forgot about.

**Tool-error rate per tool.** One tool failing is an outage in that tool. Every tool
failing is your network.

## What this costs, and where it goes

Everything above is derived from rows this app already writes. `/ops/sli` computes over
`agent_runs` and `agent_run_steps` directly, so the in-app SLI page works with zero
external infrastructure — no Prometheus required to answer "is it working". The
Prometheus counters and histograms exist in parallel for the local Grafana stack and for
alerting, and the GitHub Actions uptime check reads `/ops/sli` every thirty minutes and
opens an issue when the run success rate drops below 80 % with at least ten runs.

That is the whole bridge from this module into the SRE ones: you have now written a loop,
you know which four things about it can go wrong, and you know which number moves first
for each. M14 builds the dashboard. M15 breaks something on purpose and makes you find it
with these.

> **Where is this in the code?**
> Steps are written by `RunRecorder` in `apps/api/src/model/runs.ts` and read back by
> `GET /model/runs/:id`. The viewer is `apps/web/src/features/runs/AgentTrace.tsx`, which
> takes `RunStep[]` and nothing else — which is why the same component renders the server
> loop's trace, your worker's trace and a historical failure identically. Client-reported
> steps come in through `POST /model/runs/:id/steps` in `apps/api/src/model/routes.ts`,
> capped at 20 steps of 8 KB. The metric names and their alert thresholds are the table
> in `docs/05-quality-and-ops.md`.

> **What to measure**
>
> If you build a harness of your own and only have time for four things:
>
> - **One row per step, written as it happens**, with latency and tokens on the model
>   calls. Everything else can be computed from this later; nothing can be recovered
>   without it.
> - **A stop reason on every run**, from a small closed set. `completed` and `failed` is
>   not enough — you will want `max_iterations` and `cancelled` within a week.
> - **Prompt tokens per run**, because that is the bill and it grows quadratically with
>   iterations when tool results are large.
> - **`parse_ok` on every tool call.** It is one boolean and it is the earliest warning
>   you will get that a schema and a model have stopped agreeing.
