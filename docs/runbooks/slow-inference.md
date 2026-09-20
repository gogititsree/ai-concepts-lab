# Runbook — slow inference

**Fires on:** `histogram_quantile(0.95, rate(model_call_duration_seconds_bucket[15m])) > 30`
for 15 min (Grafana rule `lab-alert-model-p95`), or `/ops/sli` → `modelCalls.p95Ms` over
30 000, or `MODEL_TIMEOUT` appearing in `errorCodes`.

**User impact:** runs still complete, they just take longer than anyone will wait for.
Past 90 s per call they stop completing at all — `MODEL_TIMEOUT_MS` is 90 000 — and past
five minutes per *run* the wall-clock guard fires with `RUN_TIMEOUT`. The first
observable symptom is usually a rising `cancelled` share, because people give up.

---

## Know the normal numbers before you touch anything

Everything here was measured on this machine (`docs/spike-notes.md`). Without these, "slow"
has no meaning and you will chase a cold start for an hour.

| Situation                                      | Measured                        |
| ---------------------------------------------- | ------------------------------- |
| Warm call                                       | **6–45 s** (M0: 12.6–43.8 s ×5) |
| First call after idle (**cold model load**)     | **+20–40 s** on top             |
| Cold plain chat, end to end (M9)                | 32.3 s                          |
| Two-iteration agent run, warm (M10)             | 18.7–20.9 s total               |
| Same run, first of the session                  | **68.0 s**                      |
| Same question with **6 tools** instead of **1** | 227 → **1052** prompt tokens, 23.5 s → **71.2 s** first call |
| Tool execution                                  | **2–9 ms** — inference is > 99.9 % of the wall clock |

Two consequences worth holding on to: **a single cold load can breach the 30 s SLO by
itself** (which is why the alert has a 15-minute pending period), and **tool descriptions
are prompt text that is re-sent every iteration**, so "someone ticked five extra
checkboxes" is a real and common cause of a 3× slowdown.

## Symptoms

- `/ops` → **Model call p95** tile red; the meter past the 30 s mark.
- p50 and p95 both up → systemic. p50 normal, p95 up → a few slow calls, usually cold loads.
- `cancelled` share rising in the outcome bar.
- `MODEL_TIMEOUT` in **Error codes**, meaning calls are hitting the 90 s ceiling.
- Run wall clock diverging from `model_latency_ms_total` → the time is **not** in
  inference, which is a different and more interesting bug (see Follow-ups).

## Diagnose

```bash
# 1. Is this a cold load, or is everything slow?  `until` is when it unloads;
#    a model that is not listed is not resident and the next call pays 20-40 s.
ollama ps

# 2. Is something else resident and competing for memory/GPU?
ollama ps | wc -l

# 3. What is the machine doing?  (Windows)
powershell -Command "Get-Counter '\Processor(_Total)\% Processor Time' -MaxSamples 3"
#    Linux/macOS: top -b -n1 | head -15

# 4. Time one call yourself, outside the app, and read the breakdown.
#    `load_duration` is the cold-load component; `eval_duration` is generation.
curl -s http://localhost:11434/api/chat -d '{
  "model":"gemma4:latest","stream":false,"think":false,
  "messages":[{"role":"user","content":"reply with: pong"}]
}' | jq '{total_duration, load_duration, prompt_eval_count, eval_count, eval_duration}'

# 5. What is the app seeing, and on which runs?
curl -s -H "Authorization: Bearer $(grep '^METRICS_TOKEN=' .env | cut -d= -f2-)" \
  "http://localhost:3000/api/v1/ops/sli?hours=1" \
  | jq '{p50: .modelCalls.p50Ms, p95: .modelCalls.p95Ms, max: .modelCalls.maxMs, calls: .modelCalls.count, tokens: .tokens}'
```

Then open a slow run under `/runs` and read the trace: `prompt_tokens` on the first
`model_call` tells you immediately whether the prompt grew.

| Reading                                                     | Cause                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| (4) `load_duration` is most of `total_duration`             | Cold load. → **Mitigate A**                                      |
| (2) shows a second model resident                            | Memory pressure / swapping. → **Mitigate B**                     |
| First-call `prompt_tokens` ≫ 300                             | Too many tools, or a long system prompt. → **Mitigate C**        |
| `eval_count` in the hundreds for a short answer              | The model is *thinking*. → **Mitigate D**                        |
| p95 high, p50 normal, `ollama ps` empty between runs         | The model keeps unloading. → **Mitigate A**                      |
| Wall clock ≫ `model_latency_ms_total`                        | Not inference at all. → Follow-ups                               |

## Mitigate

**A — cold loads.** Keep the model resident:

```bash
ollama run gemma4:latest ''    # pay the load now, not on the learner's first click
```

The adapter already sends `keep_alive: '10m'` on every request (`model/ollama.ts`), which
covers a working session. If the model still unloads, the host is under memory pressure —
that is B.

**B — something else is resident.** Stop it:

```bash
ollama stop <other-model>
```

An 8B model at Q4_K_M plus anything else is where a laptop starts swapping, and a swapping
model is 5–10× slower rather than 20 % slower.

**"Anything else" includes the observability stack**, and this is not theoretical. During
M15 (`docs/postmortems/2026-09-20-ollama-down-mid-run.md`), `pnpm obs:up` — Prometheus,
Grafana, Loki and Promtail, plus Docker's WSL VM — left 482 MB free on an 8 GB machine,
and `gemma4:latest` then failed to load outright with `unable to allocate CPU_REPACK
buffer` for 1.94 GB. The tooling brought in to watch the slowness *caused* it, and
because the failure was a load failure rather than a slow load, `model_provider_up`
stayed at 1 the whole time. If the numbers went bad around the time you started watching
them, `pnpm obs:down` and measure again before changing anything else.

**C — the prompt grew.** This is the one to check first when the slowdown arrived with a
change rather than gradually. In the Module 5 exercise, untick every tool the question does
not need: the measured cost of the full catalog was 4.6× the prompt and 3× the latency for
five tools the model never called. For a genuine need, shorten the tool *descriptions* —
they are re-sent every iteration.

**D — thinking.** `OllamaProvider` already sends `think: false` on every request, and
combining `think` with `format` is refused outright (decision 16). If a `thinking` block is
showing up in `providerMeta` on the trace, something is overriding it — check the run's
`options` in `/runs/:id`.

**Reduce the blast radius while you work:**

- Lower `maxTokens` in the playground; completion tokens are the dominant generation cost.
- Agent runs are already capped at **one concurrent run per user** (`RunSemaphore` in
  `model/runEvents.ts`), so a second learner cannot make it worse — this is the semaphore
  `docs/05` calls for, and it already exists.
- If calls are timing out rather than merely dragging, raising `MODEL_TIMEOUT_MS` converts
  a failure into a long wait. Do that only knowingly: 90 s was chosen because a cold load
  plus a long generation fits inside it and anything longer is a user who has left.

## Verify

```bash
# Two calls in a row: the second is the warm number and the one to judge by.
time curl -s http://localhost:11434/api/chat -d '{"model":"gemma4:latest","stream":false,"think":false,"messages":[{"role":"user","content":"reply with: pong"}]}' > /dev/null
time curl -s http://localhost:11434/api/chat -d '{"model":"gemma4:latest","stream":false,"think":false,"messages":[{"role":"user","content":"reply with: pong"}]}' > /dev/null
```

Then run one real Module 5 agent run and check `/ops`: p50 back under ~10 s, p95 under 30 s,
`MODEL_TIMEOUT` no longer in **Error codes**. The Grafana rule clears one evaluation after
the 15-minute window rolls past the last breach, so give it 15 minutes before believing the
alert rather than the dashboard.

## Follow-ups

- **If wall clock diverged from `model_latency_ms_total`, stop and look at that instead.**
  That gap means the time is going somewhere other than inference — a tool doing I/O it
  should not, a lock, a retry loop — and on this app tool execution is 2–9 ms, so any gap
  worth noticing is a bug.
- If the cause was tool count, that is a teaching moment, not just a fix: it is the number
  behind Module 5's "tick only what you need" note.
- If the hardware is simply slower than when `docs/spike-notes.md` was written, re-measure
  and update **both** the spike notes and `MODEL_CALL_BUCKETS` in
  `apps/api/src/plugins/metrics.ts`. Buckets chosen for the wrong distribution make the
  p95 meaningless, and that failure is silent.
- Repeated breaches mean the 30 s SLO is wrong for this machine. Change the objective and
  write down why (`docs/slo.md` § error-budget policy) — a permanently red SLO trains you
  to ignore red.
