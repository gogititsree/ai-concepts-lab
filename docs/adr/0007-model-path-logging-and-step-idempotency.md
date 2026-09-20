# ADR 0007 — Model-path structured logging, and an idempotency key for reported steps

- **Status:** accepted
- **Date:** 2026-09-20 (M16, the two defects found by the M15 exercise)
- **Deviates from / changes:** `docs/05-quality-and-ops.md` → "SRE / observability → Signals"
  (four small points, §§1–4); the published request contract of
  `POST /api/v1/model/runs/:id/steps` (§5)
- **Closes:** action item 6 of `docs/postmortems/2026-09-20-ollama-down-mid-run.md`

Two unrelated defects, one change, because both live in the same two files.

**Defect 1.** `docs/05` has specified a pino line per model call since the design phase
and nothing ever emitted one. Across a whole staged incident, grepping every API log for
`runId`, `stepIndex`, `latencyMs` or `toolName` returned **zero matches**: the only
model-path log statements were three exception handlers, and a *handled*
`MODEL_UNAVAILABLE` never reaches one. Loki and Promtail ran throughout with nothing to
aggregate.

**Defect 2.** `POST /model/runs/:id/steps` was not idempotent. Three identical posts made
three steps.

---

## 1. The log lines are emitted from the metric emit sites, in `plugins/metrics.ts`

`observeModelCall`, `observeToolCall`, `observeToolExecution` and `countRunFinished` each
take an optional log context and emit **both** signals from one call with one set of
values. `docs/05` describes logs and metrics as separate "Signals" and says nothing about
where either is produced, so this is an implementation choice rather than a contradiction
— but it is worth writing down, because the obvious alternative is worse.

The alternative is a `log.info(...)` next to each `observe...(...)`. It reads better and
it drifts: two instrumentation paths that compute the same number separately eventually
disagree, and then an operator comparing a Grafana panel with a Loki query has to work
out which of their own dashboards is lying. Here `latencyMs` on the line and the
observation in `model_call_duration_seconds` are the same variable, passed once.

The cost is that `plugins/metrics.ts` is now "the telemetry emit layer" rather than "the
Prometheus registry", and its name understates it. Renaming the file was rejected as
churn across a dozen imports for a filename; the module header says what it is.

**One consequence, stated honestly:** in the agent loop the metric is now emitted *after*
the step row is written, because the line carries the step's `stepIndex` and a log entry
that lands *near* a row rather than *on* one is much less useful. If the database write
throws, that one histogram observation is lost. A database write failing mid-run fails
the whole run, which is recorded, so the trade is one lost sample against every log line
being joinable to a trace row.

## 2. `reqId` and `userId` come from the logger's bindings, not from the payload

`docs/05` lists `reqId` and `userId` among the fields, and they are on every line — but
they are put there by Fastify (which binds `reqId`) and by `auth/guards.ts` (which binds
`userId` and `sessionId` once the session resolves), not by the log objects in
`metrics.ts`.

This is not tidiness. pino writes a **duplicate JSON key** when a child binding and a log
object carry the same name, and `JSON.parse` silently keeps the last one. The first
capture of these lines during M16 had exactly that:

```
… "userId":"98fd…","sessionId":"2af2…","event":"model_call","userId":"98fd…", …
```

A line with two `userId` fields is a line a log query cannot be trusted on. So the emit
helpers take a `RunLogContext` of `{ logger, runId }` and nothing else, and the
integration suite counts both field names in the **raw text** of a line rather than
after parsing, which is the only way to catch a regression here.

The correlation `docs/05` wants still holds, and end to end: `agent_runs.request_id` is
`String(request.id)`, which is the same value Fastify binds as `reqId`. A Loki search by
request id reaches the run row; the run row reaches the trace. Verified against a real
`gemma4:latest` run: `reqId:"req-3"` on the lines, `request_id = req-3` on the row.

## 3. Four events, not one; and a failed run is `warn`

`docs/05` specifies the field list "for model calls". The postmortem's action item also
asks for a line per run terminal state. The implemented set is:

| `event` | Where | Level |
| --- | --- | --- |
| `model_call` | after the `model_call` (or `error`) step is written | `info`, `warn` on a handled failure |
| `tool_call` | after the `tool_call` step | `info`, `warn` when `parseOk:false` |
| `tool_result` | after the `tool_result` step | `info`, `warn` when `isError` |
| `run_finished` | at the single `countRunFinished` call per run | `info` for completed/cancelled, `warn` for failed/max_iterations |
| `model_call_content` | beside `model_call` | **`debug` only** — see §4 |

**`error` is not used by any of them**, and that is the deliberate part. A run that failed
because the model server was killed is an **outage**, not a defect in this process. If a
provider being down produced `error` lines, then `level>=50` would stop meaning "something
is wrong with the code" — which is the only thing that makes the level worth having. The
existing `error` sites (`agent run crashed`, `SSE replay failed`) are untouched: those are
bugs.

`tool_call` also carries `recovered`, and `run_finished` carries the whole rollup, from
the same object written to `agent_runs` a line earlier.

### The ADR 0002 distinction is preserved in the fields

`parseOk:false` on a `tool_call` line means what
`tool_call_parse_failures_total` means and nothing wider: **the provider emitted
arguments that were not JSON**. Arguments that parse and then fail the tool's Zod schema
never appear as `parseOk:false`; they surface on the following `tool_result` line as
`isError:true, errorCode:"INVALID_ARGUMENTS"`. Two captured runs, side by side:

```
"event":"tool_call",  "parseOk":false, …            ← provider emitted malformed JSON
"event":"tool_call",  "parseOk":true,  …            ← parsed fine…
"event":"tool_result","isError":true,"errorCode":"INVALID_ARGUMENTS"   ← …and failed the schema
```

Blurring them would make a log query as unactionable as the metric would be, and for the
same reason: the two have different fixes (a model or prompt problem versus a tool
description problem).

### Client-reported steps are logged but not metered

Steps that arrive over `POST /model/runs/:id/steps` get the same line shapes plus
`reportedBy:"client"`, and **no** metric. That is a deliberate non-change: M14 counts
client-reported tool calls in the run's rollup columns and nowhere else, and a browser's
tool timings mixed into `tool_execution_duration_seconds` would make that histogram mean
two things at once. It is the one place a line has no metric to agree with.

## 4. Prompts at `debug`, and only at `debug`

`docs/05`: *"Never log prompt contents at `info` (they're in the DB); `debug` may."*
Implemented as a separate `model_call_content` line whose payload is built by a **thunk**
behind an explicit `isLevelEnabled('debug')` check, so at the default level the
transcript is not serialised in order to be discarded. The `model_call` line itself never
carries text at any level.

The test asserts both halves. Asserting only "the prompt is absent at `info`" would pass
if the code never had the prompt in the first place, so the same run is driven at `debug`
and the prompts are asserted **present**. Captured: 0 matches for the marker strings
across every line of a four-run `fake` session and of the real `gemma4:latest` run.

---

## 5. `POST /model/runs/:id/steps` now requires a `clientStepId` per step

**This is a breaking change to a published request contract**, which is why it is here.

`agent_run_steps` has `UNIQUE (run_id, step_index)`, which looks like replay protection
and is not: the **server** allocates `step_index`, so a re-sent step took the next free
one and the constraint could never fire. Three identical posts made three rows. The
exposure was low only because the harness worker does not retry — and adding a retry to a
network call is the obvious next change, at which point one blip duplicates steps in the
learner's trace. A duplicated step is worse than a lost one: the trace is the product.

### The key is opaque, and per step

`ReportedStepSchema` gains `clientStepId: string` (1–64 chars, required), enforced by a
new `UNIQUE (run_id, client_step_id)` index (migration `0002_add_client_step_id`).

**Opaque rather than a sequence number**, though the worker already has a counter. A
counter would place a second position-like number beside `stepIndex`, and the two
legitimately differ — the server writes its own `model_call` rows into the same harness
run through `POST /model/chat`, so the client's third step is not the trace's third row.
Two disagreeing indices on one row is a trap for whoever reads the trace next. A sequence
number also invites a client to believe it controls ordering, which is the one thing this
endpoint must not concede. An opaque id claims only "this is the same step I sent
before".

**Per step rather than per batch.** A batch is not a stable unit: after a partial failure
the worker's next attempt may carry a different window (send 1–2, then send 1–3). A
per-batch key would have to reject that batch whole or re-insert its first two steps; a
per-step key adds only the new one. It is also the only form a database constraint can
enforce — "this batch was seen" would need a second table and its own retention problem.

### A replay is a no-op that answers like the original

`201` with the same body and the same `stepIndex` values, **not** a 409. A caller that has
to distinguish "accepted" from "already had it" has not been given idempotency; it has
been given a new error to handle. Replays consume no `step_index`, add nothing to the
rollups and publish no SSE event.

A **reused id carrying different content** is `409 IDEMPOTENCY_KEY_REUSED` (a new code in
the vocabulary). That is not a retry, it is two steps claiming one identity, and answering
with the first would hide a client bug behind the mechanism that exists to make client
bugs harmless. Sameness is decided by comparing every client-supplied field through a
key-sorted canonical JSON, because `jsonb` reorders object keys on the way in and a naive
string comparison would 409 a correct retry whose queue had been re-serialised.

A **finished run still recognises its own steps.** The worker's last post is the `final`
that closes the run, so the retry most likely to happen is the one that arrives after the
run is terminal; answering it with `RUN_NOT_RUNNING` would report a failure at the end of
a successful run. A terminal run replays known steps and refuses new ones.

### One transaction, one lock

The whole batch runs in `db.transaction` with the run row taken `FOR UPDATE`, so a
partially-applied batch is not a reachable state — the rollup `UPDATE` and the `final`
step's status change are inside it too. The lock is not decoration: `step_index` is
allocated by reading the highest and adding one, which is a read-modify-write, and two
concurrent posts (*exactly* what a retry that overtakes its original is) would otherwise
compute the same index and one would die on `(run_id, step_index)` with a 500 — turning a
harmless duplicate into an error.

A batch that repeats an id **within itself** is a `400` from the schema, before the
transaction opens: a batch that contradicts itself is a client bug with no sensible
resolution to invent.

### `step_index` stays the server's

Unchanged, and deliberately. The client says *which step this is*, never *where it goes*.

### What this costs the web app

`ReportedStep` is a shared type and `apps/web/src/features/exercises/harness/harnessCore.ts`
builds four object literals of it, so the web package will not typecheck until the worker
sends the field. That is the intended signal — a compile error is louder and cheaper than
a runtime 400 — but it does mean this change and the corresponding web change belong in
the same merge. A `TODO(web)` marks the boundary in `model/routes.ts`.

### `POST /model/runs` deliberately does **not** get the same treatment

Considered, and the conclusion is "not yet, and not the same way":

- For `kind:'agent'` the one-run-per-user semaphore already prevents a double submit from
  creating two runs; the retry gets `409 RUN_IN_PROGRESS`. Not idempotent, but not
  duplicating anything either.
- For `kind:'harness'` a double post really does create two rows — but the damage is a
  different shape. The client holds the `runId` from the response, so if the response was
  lost it cannot report steps into *either* run: the duplicate is an **orphan**, a
  `harness` run with zero steps that run-retention housekeeping collects. Untidy. A
  duplicated *step* corrupts a trace someone is reading, which is why that one was fixed
  first.
- There is no natural key in the request. Hashing the body would make "run the same
  prompt twice" — which is what Module 5's compare-two-prompts task asks a learner to do
  — collapse into one run.
- The honest fix, when the worker gains a retry, is the same mechanism: a client-supplied
  `clientRunId` on `CreateRunRequestSchema` with `UNIQUE (user_id, client_run_id)`. It is
  a strictly larger contract change (every caller of `POST /model/runs`, not just the
  worker) and it is not needed to make a retry safe today, because the retry that
  matters is now safe on its own.
