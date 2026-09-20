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

- The playground and the agent exercise show the "model unavailable" banner.
- `POST /api/v1/model/chat` and `POST /api/v1/model/runs` answer **503 `MODEL_UNAVAILABLE`**.
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

**If it cannot be fixed now:** nothing to switch off. The app already degrades correctly —
the banner explains it, modules 1–3 and 6's scripted checks are unaffected, and Module 6
is completable with no model at all.

## Verify

```bash
# The probe the gauge is built on.
curl -s http://localhost:3000/api/v1/model/health | jq '.ok, .models'

# The gauge itself. Give it one scrape interval (15 s) to flip.
curl -s -H "Authorization: Bearer $(grep '^METRICS_TOKEN=' .env | cut -d= -f2-)" \
  http://localhost:3000/metrics | grep '^model_provider_up'
```

Then do a real end-to-end check rather than trusting the probe: run one Module 4 prompt and
confirm it returns, and reload `/ops` — the **Model provider** tile should be green and the
next run should land in `completed`.

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
- Recurring? Write it up in `docs/postmortems/` and add an action item. Two of these in a
  month is a pattern, not bad luck.
