# Runbook — runaway loops (`max_iterations` share rising)

**Fires on:** `(failed + max_iterations) / all finished runs > 0.25` for 15 min (Grafana
rule `lab-alert-bad-outcomes`), or `/ops` → **Failed + capped** tile red, or mass piling up
in the last bucket of the iteration histogram.

**User impact:** runs take the maximum time the cap allows and then answer "Stopped after N
iterations without a final answer". Every one of them spent 8–15 model calls of local
inference to produce nothing — on this hardware, minutes each.

---

## Read this first: `max_iterations` is not an error

It is a **bounded outcome** with its own status, and that is the whole reason this runbook
can exist. A run that hits the cap did not crash: the loop stopped it on purpose. So:

- it never appears in an error rate,
- `/health` stays `ok`,
- nothing throws, nothing is logged at `error`,
- and the only thing that moves is `agent_runs_total{status="max_iterations"}` and the
  right-hand end of `agent_run_iterations`.

This is precisely the failure Module 5 lesson 4 is about — "an agent that fails does not
usually throw". If the alert has fired, **split the two halves before doing anything
else**, because they have nothing in common:

```bash
curl -s -H "Authorization: Bearer $(grep '^METRICS_TOKEN=' .env | cut -d= -f2-)" \
  "http://localhost:3000/api/v1/ops/sli?hours=24" | jq '{byStatus: .runs.byStatus, errorCodes: .errorCodes}'
```

- Mostly `failed` with `MODEL_UNAVAILABLE` → `docs/runbooks/model-provider-down.md`.
- Mostly `failed` with `MODEL_TIMEOUT` or `RUN_TIMEOUT` → `docs/runbooks/slow-inference.md`.
- Mostly `max_iterations` → keep reading.

## Symptoms

- `/ops` → iteration distribution with a bar at the `9–15` bucket where there was none.
- Mean iterations climbing (normal for this app's exercises is **2**: one call to decide on
  a tool, one to answer with the result — see the canonical trace in `docs/spike-notes.md`).
- Tool call count per run climbing in step with iterations.
- Grafana panel 6 (`agent_run_iterations`) with visible mass at `le=15`.

## Diagnose

**Read one whole trace.** A runaway loop is a behaviour, and the aggregate cannot show you
what the model kept doing. `/runs` → open a capped run → read the steps in order.

```bash
# The capped runs, with what they were asked and how much they burned doing it.
psql "$DATABASE_URL" -c "
  select id, iteration_count, tool_call_count, prompt_tokens_total,
         model_latency_ms_total, left(user_prompt, 60) as prompt
  from agent_runs
  where status = 'max_iterations' and started_at > now() - interval '24 hours'
  order by started_at desc limit 10;"

# The shape of the loop: what did it call, over and over?
psql "$DATABASE_URL" -c "
  select iteration, kind, tool_name, left(tool_args::text, 80) as args
  from agent_run_steps where run_id = '<run-id>' order by step_index;"
```

What you are looking for, in the order these actually occur:

| Pattern in the trace                                         | Cause                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| The **same tool, same arguments**, every iteration            | The model is not reading the result. → **Mitigate A**                   |
| Same tool, arguments drifting slightly each time              | It is not getting the answer it wants. → **Mitigate B**                 |
| Alternating between two tools                                 | The question needs neither, or both are described too similarly.        |
| `tool_result` with `is_error` every time                      | A broken tool, not a broken prompt. → `parse-failure-spike.md` / fix it |
| Long assistant text and no `final`                            | The model never stops asking. → **Mitigate C**                          |
| The question genuinely needs more than 8 steps                | Not a runaway. → **Mitigate D**                                         |

Also check what changed: `git log --oneline -15 -- apps/api/src/model/tools/ content/modules/05-agents/`
and whether `OLLAMA_CHAT_MODEL` moved. Prompts and tool descriptions are the usual culprit,
and both live in the repo.

## Mitigate

**A — the model is ignoring tool results.** Almost always the tool's *output* is not
self-explanatory: a bare number, or a JSON blob with no units. Fix the tool's return shape
first — it is cheaper and more durable than prompt wording, and it lives in
`apps/api/src/model/tools/`.

**B — the arguments drift.** The tool's description is promising something it does not
deliver. Read `GET /api/v1/model/tools` — that is literally what the model was told — and
make the description match the behaviour.

**C — tighten the system prompt.** Say when to stop, not just what to do: *"When you have
the number, give the final answer in plain text. Do not call a tool twice with the same
arguments."* Then measure over **five runs**, not one: the M0 spike's 3/5 would have read
as either 100 % or 0 % on a single trial, and prompt changes are exactly where that trap
lives.

**D — lower the cap so the failure is cheap.** `maxIterations` defaults to 8 with a hard
cap of 15 (`AGENT_MAX_ITERATIONS_CAP`). If the loop is going to fail, failing at 4 costs
half as much inference and tells you the same thing. The exercise's own config can set it;
the hard cap in `model/agentLoop.ts` is the backstop and should stay where it is.

**Stop a run that is going now:** the cancel button on the exercise, or

```bash
curl -X POST -H 'X-Requested-With: fetch' -H "Cookie: sid=<yours>" \
  http://localhost:3000/api/v1/model/runs/<run-id>/cancel
```

Cancel really aborts the inference rather than just closing the stream, so it frees the
model immediately. The run is recorded as `cancelled` with its partial trace intact.

Note that concurrency is already bounded: one agent run per user at a time
(`RunSemaphore`), a five-minute wall clock per run, and ten seconds per tool. A runaway
loop costs you minutes, not a machine.

## Verify

Run the affected exercise **five times** and check the distribution, not the mean:

```bash
curl -s -H "Authorization: Bearer $(grep '^METRICS_TOKEN=' .env | cut -d= -f2-)" \
  "http://localhost:3000/api/v1/ops/sli?hours=1" \
  | jq '{buckets: .iterations.buckets, mean: .iterations.meanPerRun, byStatus: .runs.byStatus}'
```

Healthy for this app's exercises: everything in the `2` bucket, mean ≈ 2, zero
`max_iterations`. A single good run proves nothing — that is the point of reading the
histogram.

## Follow-ups

- Capped runs are the best teaching artefacts this app produces. Keep one: link its
  `/runs/:id` from the postmortem, and consider it for Module 5 lesson 4.
- If a prompt change fixed it, the prompt now has a regression test's worth of value.
  Module 4 lesson 2 argues for keeping a fixed suite of prompts and running it on every
  change; this is the moment that argument gets concrete.
- If the cap was hit because the task genuinely needs more steps, the *exercise* is wrong,
  not the loop. Say so rather than raising the cap and moving on.
- Compare the tokens burned (`prompt_tokens_total` on the capped runs) against a normal
  run's ~530. That ratio is the cost of the failure, and it is the number that justifies
  spending an afternoon on the prompt.
