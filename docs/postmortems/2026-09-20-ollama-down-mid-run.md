# Postmortem — Ollama killed mid-run: the trace, the metrics and the alert all worked; the UI banner never moved

- **Date:** 2026-09-20
- **Authors:** the one person who works on this (M15, the deliberate "break something" exercise)
- **Status:** final

> The alternate scenario in `docs/05-quality-and-ops.md`, run as an incident rather than as
> a smoke test. M14 had already confirmed the mechanics; this run watched all seven items
> on the document's expected-behaviour list, from a real browser with a real agent run in
> flight, and `docs/05` is explicit that **"anything that does not happen in that list is a
> bug found by the exercise"**. One item did not happen, and the recovery surfaced a
> second, sharper problem that nobody was looking for.
>
> Staged locally against the real stack: Postgres 16 in Docker, `apps/api/dist` in
> `NODE_ENV=production` serving the built SPA, `MODEL_PROVIDER=ollama` /
> `gemma4:latest`, the full `pnpm obs:up` profile (Prometheus, Grafana, Loki, Promtail),
> and Chromium driving the real Module 5 exercise page. There is no deployed instance to
> stage it on; on the deployment this failure cannot occur at all, because it runs
> `MODEL_PROVIDER=none` on purpose.

## Summary

Ollama was killed while a Module 5 agent run was mid-inference; the run failed correctly
with `MODEL_UNAVAILABLE`, kept its partial trace, drove `model_provider_up` to 0 within two
seconds and fired the Grafana alert 5 minutes 34 seconds later. The "no model attached"
banner **never appeared** on the open exercise page — after 121 seconds of watching, it
took a full page reload — because the model-health query has no poll interval and window
refetching is disabled.

## Impact

**Who:** one learner, on the Module 5 exercise page. Modules 1–3 and Module 6's scripted
checks are unaffected by a missing model, by design, and `/health` deliberately stays `ok`.

**What:** the in-flight run failed. `POST /model/chat` answered 503 `MODEL_UNAVAILABLE`.
`POST /model/runs` **accepted** new runs and failed them a moment later (see Findings).
Everything outside modules 4–6 was untouched.

**How long:** Ollama was down from 02:26:46Z to 02:33:21Z — **6 minutes 35 seconds** — and
a further 3 minutes 40 seconds passed before inference actually worked again at 02:37:01Z,
for a reason that had nothing to do with the original fault. Total user-visible model
outage: **10 minutes 15 seconds**.

## Detection

**How it was found:** by the failing run itself. The browser rendered the `error` step
within five seconds of the kill, with the exact operator-facing message — "Could not reach
the local model. Is Ollama running? Start it with `ollama serve`." That is the fastest and
most useful detection in the whole exercise, and it came from the application, not the
monitoring stack.

**How long after the start:** under five seconds, for a user who happened to be running
something. For a user who was not, the first signal would have been the banner — which did
not work — so in practice: the next time they clicked Run.

| Monitor | Fired? | Latency after the kill |
| --- | --- | --- |
| The run itself (UI error step, partial trace) | **yes** | < 5 s |
| `model_provider_up` at `/metrics` | **yes** | ≤ 2 s (02:26:48Z) |
| Prometheus | **yes** | 13 s (02:26:59Z) — one scrape interval |
| Grafana `lab-alert-provider-down` → Pending | **yes** | 34–46 s (evaluated 02:27:20Z) |
| Grafana `lab-alert-provider-down` → **Firing** | **yes** | **5 min 34 s** (evaluated 02:32:20Z) |
| Grafana `lab-alert-model-errors` (> 20 % for 10 min) | Pending only | 3 min 34 s to Pending; the provider came back before it fired |
| The "no model attached" banner | **NO** | never, without a reload |
| `GET /health` | correctly silent | stays `ok` by design (`docs/slo.md` § 1) |
| `.github/workflows/uptime.yml` | correctly silent | `status=ok`, and 1 failed run of 70 is nowhere near the SLI floor |
| pino → Loki | **nothing to see** | the run failure produced **no log line at all** (see Findings) |

The 5 min 34 s to firing is the designed number — a 5-minute `for:` plus Grafana's
1-minute evaluation granularity — and the rule cleared one evaluation after the provider
returned (02:34:20Z), exactly as `docs/runbooks/model-provider-down.md` promises.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| 02:22:57 | `pnpm obs:up`. Prometheus, Grafana, Loki, Promtail start. |
| 02:24:51 | Watcher baseline: `model_provider_up{provider="ollama"} 1`, Prometheus `1`, `Model provider down for 5 minutes` = **inactive**. |
| 02:25:52 | Chromium registers a fresh learner and opens `/modules/agents/exercise`. Banner absent, as expected. |
| 02:25:54 | Run `496df294` started (`kind=agent`, `calculator` attached, a three-step arithmetic prompt). |
| 02:26:35 | First trace step renders. The opening `model_call` took **40 740 ms** — within the measured 6–45 s warm envelope in `docs/spike-notes.md`. |
| 02:26:43–02:26:46 | `taskkill /F /IM "ollama app.exe" /IM ollama.exe`. |
| **02:26:46** | **Impact starts.** Ollama is gone, mid second model call. |
| 02:26:47.083 | Run row terminal: `status=failed`, `error_code=MODEL_UNAVAILABLE`, `iteration_count=1`, `tool_call_count=1`. 4 steps persisted: `model_call` (40 740 ms), `tool_call` (`calculator`, `parse_ok=true`), `tool_result` (15 ms), `error`. **0.6 s from kill to a durable, complete trace.** |
| 02:26:48 | `/metrics` reports `model_provider_up{provider="ollama"} 0`. |
| 02:26:51 | Browser (+5 s, untouched): trace reads `model_call, tool_call, tool_result, error`; the error card shows the operator message; the Run button is re-enabled, i.e. the SSE `end` event arrived and the hook settled. **Banner count: 0.** |
| 02:26:59 | Prometheus has scraped the 0. |
| 02:27:20 | Grafana evaluation → **Pending**. |
| 02:26:51 → 02:28:47 | 24 consecutive checks, 5 s apart, of the untouched page. **Banner count: 0, every time.** |
| 02:30:20 | `lab-alert-model-errors` also goes Pending. |
| **02:32:20** | Grafana `lab-alert-provider-down` → **Firing**. 5 min 34 s after the kill. |
| 02:28:51 | Page reloaded. **Banner appears immediately.** |
| 02:33:15 | `ollama serve` restarted (runbook, Mitigate A). |
| 02:33:21 | `GET /api/tags` answering (6 s). `GET /api/v1/model/health` → `{"provider":"ollama","ok":true,…}`. |
| 02:33:21–02:33:26 | The runbook's pre-load step **fails**: `ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 1941258240` / `unable to allocate CPU_REPACK buffer`. |
| 02:33:35 | `POST /model/chat` → **503 `MODEL_UNAVAILABLE`, "The model server returned HTTP 500."** — while `/model/health` says `ok: true` and `model_provider_up` reads **1**. |
| 02:34:20 | Grafana rule → **inactive**, one evaluation after the gauge returned to 1. The alert is now green and inference is still broken. |
| 02:34:47–02:36:00 | `pnpm obs:up` stack down; Postgres container down; `wsl --shutdown`; a stale `llama-server` process killed. Free RAM 482 MB → ~800 MB on an 8 GB machine. |
| 02:37:01 | Model loads and answers in 19 s. |
| 02:37:23 | Postgres back up. `/health` `ok`, `/model/health` `ok`. |
| 02:38:06 | A full agent run completes: 2 iterations, "The answer to 144 divided by 12 is 12." |
| 02:38:06 | **Incident closed.** |

## Root causes

**Technical (the incident).** The model server process was killed. There is nothing to fix
about that; it is the scenario.

**Technical (the bug the scenario exposed).**
`apps/web/src/features/exercises/prompt/useChatRun.ts` → `useModelHealth()` sets
`staleTime: 15_000` and `retry: false` and **no `refetchInterval`**, and
`apps/web/src/lib/queryClient.ts` sets `refetchOnWindowFocus: false` globally. The
`['modelHealth']` query is therefore refetched only on component mount. Nothing
invalidates it when a run fails with `MODEL_UNAVAILABLE`. `modelDown` in
`AgentExercise.tsx` is computed as `health.data !== undefined && !health.data.ok`, so on a
page that was opened while the provider was healthy, the banner can never appear, no
matter how long the learner waits or how many runs fail.

The comment above `staleTime` says the interesting transition is "I just started Ollama"
and that a stale banner telling someone to start a server they already started is the
annoying failure mode. That reasoning is sound and it optimised for one direction of the
transition while silently giving up the other.

**Process.** `docs/05` states the expected behaviour ("the banner flips to 'model
unavailable' within one health-poll interval") and no test asserts it. The Playwright E2E
runs with `MODEL_PROVIDER=fake`, which is always healthy, so it asserts only that the
banner is *absent*. There is no test — at any level — for the banner ever being *present*,
and therefore none for it appearing in response to a change.

## Contributing factors

- **The observability stack caused the recovery failure.** Prometheus, Grafana, Loki and
  Promtail were started *to observe this incident* and, on an 8 GB machine, took the RAM
  the 8B model needs for its 1.94 GB repack buffer. The tooling brought in to watch the
  system is what stopped the system recovering. This is not a hypothetical trade-off in a
  textbook; it is four containers and one laptop.
- **A stale `llama-server` process survived the `taskkill`** and held 272 MB, which pushed
  the retry over the edge as well.
- **Two Grafana rules were already firing before the incident began** —
  `Tool-call parse-failure rate above 10 %` since 02:03:20Z (the calculator tool has an 80
  / 185 historical parse-failure rate) and `Failed + max_iterations share above 25 %` from
  02:23:20Z. The provider-down alert arrived on a dashboard that was already red. An
  alerting surface with permanent red on it is one nobody reads.

## Findings — `docs/05`'s expected list, item by item

`docs/05`: *"Expected: the in-flight step fails with `MODEL_UNAVAILABLE`, the run is
persisted with `status='failed'` and an `error` step, the SSE stream sends a terminal
event, the UI shows the partial trace and the banner flips to 'model unavailable' within
one health-poll interval, `model_provider_up` goes to 0, Grafana alert fires after 5 min.
Anything that doesn't happen in that list is a bug found by the exercise."*

| # | Expected | Observed |
| - | -------- | -------- |
| 1 | in-flight step fails with `MODEL_UNAVAILABLE` | ✅ `error_code=MODEL_UNAVAILABLE` |
| 2 | run persisted `status='failed'` with an `error` step | ✅ at 02:26:47.083Z, 0.6 s after the kill |
| 3 | SSE sends a terminal event | ✅ the hook settled and re-enabled Run within 5 s |
| 4 | UI shows the partial trace | ✅ all four steps, grouped by iteration, with the tool call and its result intact |
| 5 | **banner flips within one health-poll interval** | ❌ **never, in 121 s. There is no health poll.** |
| 6 | `model_provider_up` goes to 0 | ✅ ≤ 2 s in the app, 13 s in Prometheus |
| 7 | Grafana alert fires after 5 min | ✅ 5 min 34 s |

### Three further bugs, none of them on that list

**A. `POST /api/v1/model/runs` does not return 503 when the provider is down.**
`docs/runbooks/model-provider-down.md` says, under Symptoms: *"`POST /api/v1/model/chat`
and `POST /api/v1/model/runs` answer **503 `MODEL_UNAVAILABLE`**"*. Measured at 02:26:5xZ
with Ollama dead: `/model/chat` → **503** (correct); `/model/runs` → **202
`{"status":"running"}`**, followed by a run that fails asynchronously. That is defensible
behaviour — the run row and its trace are the product, and a run that records why it could
not start is more useful than a bare 503 — but the runbook is wrong, and a runbook that is
wrong about a symptom sends you down the wrong branch of its own decision table.

**B. A failed run produces no log line whatsoever.** `docs/05` specifies structured pino
fields for model calls: `runId`, `stepIndex`, `provider`, `model`, `latencyMs`,
`promptTokens`, `completionTokens`, `toolName`, `parseOk`, `errorCode`. Grepping every API
log from this session for any of `runId`, `stepIndex`, `latencyMs`, `toolName`: **zero
matches.** The only model-path log statements in `apps/api/src/model/` are three exception
handlers (`agent run crashed`, `SSE replay failed`, and two embed warnings), and a
`MODEL_UNAVAILABLE` failure is *handled*, so none of them fire. Across the whole incident
the API logged 196 `info` lines (HTTP request/response) and 4 `warn` lines (all from
boot-time configuration checks).

Consequence: **Loki and Promtail were running throughout and had nothing to contribute.**
Everything worth knowing was in Postgres and Prometheus. The log-aggregation third of the
M14 observability stack is, today, an HTTP access log. ADR 0006 records five M14
deviations and this is not among them, so it is a genuine gap rather than a documented
trade-off.

**C. `model_provider_up` measures reachability, not the ability to serve.** From 02:33:21Z
to 02:37:01Z — **3 minutes 40 seconds** — `GET /api/v1/model/health` returned
`{"ok":true,"models":["nomic-embed-text:latest","gemma4:latest"]}`, `model_provider_up`
read 1, and the Grafana alert went green at 02:34:20Z, while every actual inference
returned `503 MODEL_UNAVAILABLE / "The model server returned HTTP 500."` because the model
could not be loaded into memory. The probe asks `/api/tags` whether the configured tag
exists. It does. Loading it is a different question.

**This is the same bug as incident 1, one layer up.** `/health` checks that the database
answers, not that the queries work; `model/health` checks that the model is listed, not
that it can run. Both were green while the thing they are supposed to represent was
broken. The recurring shape is: *a dependency check that tests the cheapest possible
interaction with the dependency.*

## What went well

- **The trace store is the star of this incident, and the design paid off exactly as
  `docs/02-schema.md` and `docs/05` claimed it would.** 0.6 seconds after the process
  died there was a durable, complete, inspectable record in Postgres of everything that
  had happened — including the 40.7 s model call and the successful tool round trip — plus
  a terminal run row with a code and a human-readable message. No external tracing system
  was involved and none was needed.
- **The error message is genuinely good.** "Could not reach the local model. Is Ollama
  running? Start it with `ollama serve`." is what the user sees, what the DB stores and
  what the runbook tells you to do, in one string.
- **The Grafana rule behaved exactly as documented**, in both directions: 5 min 34 s to
  fire (5-minute `for:` plus 1-minute evaluation) and back to Normal within one evaluation
  of recovery, precisely as `docs/runbooks/model-provider-down.md` says.
- **Degradation was correctly scoped.** `/health` stayed `ok`, `uptime.yml` stayed quiet,
  nothing paged, and modules 1–3 were unaffected. The decision that a missing model is not
  an outage held up under a real missing model.
- **The `error` step rendered with its iteration grouping intact** — the trace viewer
  handled a partial, failed run without special-casing.

## What went poorly

- The banner, the one piece of UI whose entire job is to tell a learner the model is gone,
  did not tell them. For two minutes, on an open page, with a failed run visible above it.
- Log aggregation contributed nothing because there is nothing to aggregate.
- The runbook's symptom table is wrong about `/model/runs`.
- Recovery took longer than the outage, and the monitoring stack caused it.
- `model_provider_up` went green 3 min 40 s before the model actually worked, taking the
  alert with it. If this had been a real incident, that is the moment someone closes the
  ticket.

## Where we got lucky

- **The kill landed between model calls rather than during a tool execution**, so the
  trace has a clean `tool_result` before the `error`. A kill 200 ms earlier would have
  produced a `tool_call` with no result and no error, and the trace viewer's handling of
  that shape is untested.
- **The learner was watching the run.** That is the only reason the failure was noticed at
  all within five seconds; the mechanism that was *supposed* to inform a non-watching
  learner is the one that was broken.
- **The memory exhaustion happened during a staged exercise, with the operator already
  in the runbook.** The same sequence at 2am — restart Ollama, see `model/health: ok`, see
  the alert clear, walk away — produces a silent, continuing outage with a green
  dashboard. This is the closest the exercise came to a genuinely dangerous failure, and
  it was found by accident.
- **`gemma4:latest` fits on this machine at all.** 9.6 GB of model on 8 GB of RAM works
  because of lazy tensor reads; four more containers is apparently the margin.

## Action items

| # | Action | Type | Owner | Due | Status |
| - | ------ | ---- | ----- | --- | ------ |
| 1 | **Give `useModelHealth` a `refetchInterval`** (30 s is one scrape interval's worth and matches the `/ops` page's existing cadence) **and invalidate `['modelHealth']` when a run or chat fails with `MODEL_UNAVAILABLE`.** The second half is the important one: the app already knows the provider is down at that moment and should not wait for a poll to agree. | detect | learner | next session | open |
| 2 | **Assert the banner appears.** A Testing Library test that flips the mocked `/model/health` response and expects `model-unavailable-banner` to render — the transition, not just the steady state. The E2E cannot do this (`fake` is always healthy) and should not try. | prevent | learner | next session | open |
| 3 | **Fix `docs/runbooks/model-provider-down.md`'s Symptoms section**: `POST /model/runs` answers 202 and then fails the run; only `/model/chat` answers 503. Add "how to find the failed run" in the same breath. | mitigate | learner | 2026-09-20 | **done** |
| 4 | **Record in the runbook that `model/health` ok ≠ inference works**, with the `CPU_REPACK` failure as the worked example, and make "run one real prompt" a required step of Verify rather than a suggestion. | mitigate | learner | 2026-09-20 | **done** |
| 5 | **Note the memory interaction in `docs/runbooks/slow-inference.md` and the observability README**: on an 8 GB machine, `pnpm obs:up` and `gemma4:latest` compete, and the model loses. | mitigate | learner | 2026-09-20 | **done** |
| 6 | **Emit one structured pino line per model call and per run terminal state**, with the field list `docs/05` already specifies. This is the missing third of the observability stack, and it is a small change in two known call sites (`model/agentLoop.ts`, `model/routes.ts`) where the numbers are already in hand for the metrics. | detect | learner | 2026-09-20 | **done** (M16) |
| 7 | **Make the provider probe attempt a real (tiny) generation**, not just `/api/tags`, so `model_provider_up` means "can serve". Deliberately *not* scheduled: a probe that runs inference every 15 s on a laptop competes with the learner for the GPU, which is a worse problem than the one it solves. The honest fix is probably to probe on failure rather than on a timer. Needs thought before it needs code. | detect | learner | backlog (design first) | open |

#### Item 6, as built (M16)

Done, and the estimate in the row above was right about the call sites and wrong about
one thing: the lines are emitted **from inside** the metric emit helpers
(`observeModelCall`, `observeToolCall`, `observeToolExecution`, `countRunFinished` in
`plugins/metrics.ts`) rather than beside them, so the line and the metric are one call
with one set of numbers and cannot drift apart. Five events —  `model_call`,
`tool_call`, `tool_result`, `run_finished`, and `model_call_content` at `debug` only —
with `warn` for handled failures and `error` reserved for genuine bugs, because a run
that failed when Ollama was killed is an outage and logging it at `error` would teach
the reader to ignore the level.

The finding that motivated the item is now a test. `test/integration/model-logging.test.ts`
drives a run whose provider answers `MODEL_UNAVAILABLE` and asserts the line exists, at
`warn`, with `errorCode:"MODEL_UNAVAILABLE"` and the `stepIndex` of the `error` row —
i.e. exactly the line whose absence made this incident invisible to Loki.

Two things surfaced while building it, both recorded in
`docs/adr/0007-model-path-logging-and-step-idempotency.md`: `reqId` and `userId` must
come from the request logger's **bindings** rather than the payload (pino writes the key
twice otherwise, and the first capture did), and `parseOk` on the log line had to be
held to ADR 0002's meaning so a query for malformed provider JSON does not also return
schema rejections.

Verified against the real stack before merge: four `MODEL_PROVIDER=fake` runs
(completed, failed, `max_iterations`, malformed args) and one real `gemma4:latest` run —
42.9 s first call, 3.4 s second, `iterations:2`, `promptTokens:419`, `latencyMs:46345`,
matching the `agent_runs` row exactly, with `reqId:"req-3"` equal to its `request_id`
and zero occurrences of the prompt text anywhere in the log.

### Considered and not done

- **Retrying the model call.** `docs/runbooks/model-provider-down.md` already argues this
  out and the argument still holds: a retry against a provider that is down doubles the
  wait before the user is told the truth. Nothing in this incident changes that. Revisit
  only if the provider starts *flapping* rather than dying.
- **Making a dead provider turn `/health` `degraded`.** Tempting, and wrong: the deployed
  instance runs `MODEL_PROVIDER=none` by design, so `degraded` would be its permanent
  steady state and the distinction would teach the reader to ignore it. `docs/slo.md` § 1
  already makes this argument.
- **Alerting on `model_call_errors_total` faster than 10 minutes.** It went Pending at
  02:30:20Z and would have fired at 02:36:20Z — after `model_provider_up` had already
  fired at 02:32:20Z. It is the slower of two overlapping signals for the same fault, and
  tightening it would add noise without adding information.

## Lessons for the curriculum

1. **"The dependency check tests the cheapest possible interaction" is the theme of both
   M15 incidents**, and putting them side by side is the most valuable teaching artefact
   this milestone produced: `SELECT 1` versus a query that names a column, `/api/tags`
   versus a generation. Module 6 lesson 4 should say it once and then show both.
2. **A trace in your own database beats a trace in someone else's service** — this
   incident is the argument, and it is concrete: the process died, and 0.6 s later
   everything about the run was still queryable with `psql`, with no agent, no exporter and
   no retention policy. Module 5's lesson on the trace viewer should point at this run.
3. **An alert clearing is not the same as the problem being fixed.** The 3 min 40 s window
   where `model_provider_up` read 1 and nothing could actually run is a small, complete
   story about why "verify with a real request" is the last step of every runbook. Add it
   to whatever lesson introduces runbooks.
4. **Observability is not free and this is the receipt.** Four containers made the model
   unloadable on the machine that was being observed. Worth one honest paragraph wherever
   the observability profile is introduced — the cost is usually money, and here it was
   the thing itself.
5. **Test the transition, not the state.** The banner test that exists asserts absence
   under a healthy provider; the bug lives entirely in the change from healthy to
   unhealthy. Generalises well beyond this banner and is worth saying in the testing
   lesson.
