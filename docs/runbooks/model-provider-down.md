# Runbook — model provider down

**Fires on:** `model_provider_up{provider!="none"} == 0` for 5 min (Grafana rule
`lab-alert-provider-down`), or `model_call_errors_total{code="unavailable"}` above 20 % of
calls for 10 min (`lab-alert-model-errors`), or `/ops/sli` showing `MODEL_UNAVAILABLE` at
the top of `errorCodes`.

**User impact:** modules 4, 5 and 6 cannot run. Everything else — lessons, quizzes,
progress, the trace viewer, `/ops` — keeps working. `/health` stays `ok`, deliberately, so
this does **not** page as an outage.

---

## Symptoms

- The playground and the agent exercise show the "model unavailable" banner — **but only
  after a page load.** Measured in M15: on a page that was already open when the provider
  died, the banner never appeared at all in two minutes of watching, because
  `useModelHealth` has no `refetchInterval` and `refetchOnWindowFocus` is off globally.
  *Do not use the absence of the banner as evidence that the provider is up.* Reload
  first. (Action item 1 in `docs/postmortems/2026-09-20-ollama-down-mid-run.md`.)
- `POST /api/v1/model/chat` answers **503 `MODEL_UNAVAILABLE`**.
- `POST /api/v1/model/runs` answers **202 `{"status":"running"}`** and *then* fails the
  run. This is deliberate — the run row and its partial trace are more useful than a bare
  503 — but it means a healthy-looking 202 is not evidence of anything. Find the run:

  ```sql
  select id, status, error_code, error_message, finished_at
  from agent_runs order by started_at desc limit 5;
  ```
- On `/ops`: the **Model provider** tile is red, `MODEL_UNAVAILABLE` leads **Error codes**,
  and the run success rate drops while `failed` grows in the outcome bar.
- In Grafana: `model_provider_up` steps to 0; `model_call_errors_total{code="unavailable"}`
  climbs.
- A run that was in flight is `failed` with an `error` step and a **partial trace** — the
  steps before the failure are already in Postgres, which is what makes this diagnosable
  at all.

## Diagnose

Work top to bottom; the first command that fails is the answer.

```bash
# 1. Is the process alive and is it answering?  (~20 ms when it is.)
curl -s --max-time 5 http://localhost:11434/api/tags | jq '.models[].model'

# 2. Is the *chat model* pulled?  A running Ollama with no gemma4 is still "down"
#    as far as this app is concerned: health() checks for the configured tag.
ollama list

# 3. Is something loaded, and is it the right thing?
ollama ps

# 4. What does the app think?  (public; no session needed)
curl -s http://localhost:3000/api/v1/model/health | jq

# 5. What is the app actually configured to reach?
grep -E '^(MODEL_PROVIDER|OLLAMA_BASE_URL|OLLAMA_CHAT_MODEL)=' .env
```

| What you see                                       | What it means                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| (1) `Connection refused`                           | Ollama is not running. → **Mitigate A**                                            |
| (1) works, (2) has no `gemma4:latest`              | The tag is missing or was renamed. → **Mitigate B**                                |
| (1) works, (4) says `provider: "none"`             | The app was started with `MODEL_PROVIDER=none`. → **Mitigate C**                   |
| (4) says `ok: false` with `Could not reach…`       | `OLLAMA_BASE_URL` points somewhere else, or a firewall is in the way.              |
| `model_provider_up` is 0 but curl works            | The scrape is stale (≤ 15 s) or the API cannot reach Ollama though your shell can. |
| (1), (2) and (4) all look fine but calls 500       | The model cannot be **loaded**, usually out of memory. → **Mitigate D** (M15)       |

## Mitigate

**A — Ollama is not running.**

```bash
ollama serve                 # foreground, or start the Ollama app on Windows/macOS
ollama run gemma4:latest ''  # forces the model into memory: pays the 20-40 s load now
```

Pre-loading matters. A cold load is 20–40 s on this hardware (`docs/spike-notes.md`), and
the first learner request after a restart will otherwise absorb it and may look like a
second incident. `keep_alive: '10m'` then holds it for a working session.

**B — the model tag is missing.**

```bash
ollama pull gemma4:latest
```

If the tag is genuinely gone upstream, set `OLLAMA_CHAT_MODEL` to what you do have and
**restart the API** — config is parsed once at boot, by design. Then note the change: the
latency numbers in `docs/spike-notes.md` and the bucket boundaries in
`apps/api/src/plugins/metrics.ts` were measured against `gemma4:latest`, and a different
model may need different buckets.

**C — the app has no provider configured.** Set `MODEL_PROVIDER=ollama` in `.env` and
restart. On the *deployed* instance this is not a fault: the free tier runs `none` on
purpose (decision 1 in `docs/07-open-decisions.md`). If the alert is firing against the
deployment, the alert is wrong — its query already excludes `provider="none"`, so check
what the deployment is actually reporting before changing anything.

**D — Ollama is running, the tag is listed, and calls still fail with
`"The model server returned HTTP 500."`** The model cannot be loaded. On this 8 GB
machine that is almost always memory, and it was observed for real in M15:

```
ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 1941258240
llama_model_load: error loading model: unable to allocate CPU_REPACK buffer
```

`ollama ps` shows an empty table — nothing is loaded — while `/api/tags` and therefore
`model/health` and `model_provider_up` all say everything is fine. Free memory in this
order, retrying the load after each step: `pnpm obs:down` (the observability profile is
the usual culprit — see `docs/runbooks/slow-inference.md`), kill any orphaned
`llama-server` process left behind by a hard kill, then `wsl --shutdown` to reclaim
Docker's VM. Then `ollama run gemma4:latest 'say ready'` and only believe it when it
answers.

**If it cannot be fixed now:** nothing to switch off. The app already degrades correctly —
the banner explains it, modules 1–3 and 6's scripted checks are unaffected, and Module 6
is completable with no model at all.

## Verify

> **`model/health: ok` does not mean inference works, and this has bitten once.** The
> probe asks Ollama's `/api/tags` whether the configured tag exists. It does not ask
> whether the model can be *loaded*. During M15's recovery, `/api/v1/model/health`
> returned `{"ok":true}` and `model_provider_up` read 1 — and the Grafana alert went
> green — for **3 minutes 40 seconds** while every real call returned
> `503 MODEL_UNAVAILABLE / "The model server returned HTTP 500."`, because `ollama serve`
> could not allocate the model's 1.94 GB repack buffer:
>
> ```
> ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 1941258240
> llama_model_load: error loading model: unable to allocate CPU_REPACK buffer
> ```
>
> The usual cause on an 8 GB machine is memory pressure, and the usual *source* of that
> pressure is embarrassing: `pnpm obs:up` (Prometheus + Grafana + Loki + Promtail) plus
> Docker's WSL VM is roughly the margin this model needs. Check `ollama ps` — an empty
> table after a "successful" restart means nothing is loaded — and read the `ollama serve`
> console for `alloc_tensor_range`. Free memory (`pnpm obs:down`, kill any orphaned
> `llama-server`, `wsl --shutdown`) and load again. **Step 3 below is not optional, and
> this is why.**

```bash
# 1. The probe the gauge is built on. Necessary, not sufficient — see the box above.
curl -s http://localhost:3000/api/v1/model/health | jq '.ok, .models'

# 2. The gauge itself. Give it one scrape interval (15 s) to flip.
curl -s -H "Authorization: Bearer $(grep '^METRICS_TOKEN=' .env | cut -d= -f2-)" \
  http://localhost:3000/metrics | grep '^model_provider_up'

# 3. REQUIRED. One real generation. The only step that proves the model can serve;
#    everything above proves only that something is listening and the tag is listed.
ollama run gemma4:latest 'say ready'
```

Then do a real end-to-end check through the app rather than trusting the probe: run one
Module 4 prompt and confirm it returns, and **reload** `/ops` and the exercise page — the
banner will not clear on its own, see Symptoms. The **Model provider** tile should be
green and the next run should land in `completed`.

In Grafana, the `lab-alert-provider-down` rule returns to **Normal** within one evaluation
(1 min) plus the 5-minute pending period it no longer needs.

## Follow-ups

- Every run that failed during the window is in `agent_runs` with `error_code = 'MODEL_UNAVAILABLE'`
  and a partial trace. Open one from `/runs` and read it — that is the artefact M15's
  postmortem exercise is built on.
- If this was a restart you caused, ask whether the app should have retried. It currently
  does not, and that is a decision, not an oversight: a retry against a provider that is
  down doubles the wait before the user is told the truth. If the provider is *flapping*
  rather than down, revisit it.
- If the load penalty was the visible problem rather than the outage, `keep_alive` is the
  knob — see `docs/runbooks/slow-inference.md`.
- **A failed run leaves no log line.** Everything you need is in `agent_runs` /
  `agent_run_steps` and in Prometheus; Loki will have only HTTP access lines, because the
  per-model-call structured logging that `docs/05-quality-and-ops.md` specifies is not yet
  implemented (action item 6 in the postmortem below). Do not waste time grepping logs for
  a run id.
- Recurring? Write it up in `docs/postmortems/` and add an action item. Two of these in a
  month is a pattern, not bad luck. The worked example is
  `docs/postmortems/2026-09-20-ollama-down-mid-run.md` (M15), which is where the three
  bugs this runbook now warns about were found: the banner that does not flip, the 202
  from `/model/runs`, and `model/health` reporting `ok` for a model that cannot load.
