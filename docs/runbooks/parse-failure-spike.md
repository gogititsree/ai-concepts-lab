# Runbook — tool-call parse-failure spike

**Fires on:** `tool_call_parse_failures_total / tool_execution_duration_seconds_count > 0.1`
over 1 h (Grafana rule `lab-alert-parse-failures`), or the **Parse-fail rate** column on
`/ops` going red for any tool.

**User impact:** usually none that anyone reports, which is exactly why this metric exists.
The loop hands a malformed call back to the model as an observation and the model often
recovers on the next turn — so the run completes, slower and with more iterations, and
looks fine from the outside. It is the **leading indicator** that a model version, a
prompt or a tool schema has drifted.

---

## Know what this counter does and does not count

This is the distinction from `docs/adr/0002-agent-tooling-deviations.md` §2, and getting it
backwards will send you to the wrong file:

| What happened                                                | Where it lands                                       |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| The provider handed back arguments that were **not JSON**     | `tool_call_parse_failures_total{recovered="false"}`   |
| Prose containing a fenced JSON call, dug out by the fallback  | `tool_call_parse_failures_total{recovered="true"}`    |
| Valid JSON that **failed the tool's Zod schema**              | a `tool_result` step with `is_error`, code `INVALID_ARGUMENTS` — **not** this counter |
| A tool name the model invented                                | a `tool_result` with `is_error`, code `UNKNOWN_TOOL`  |
| The tool itself threw                                          | a `tool_result` with `is_error`                       |

So: **this counter is about the model's output being malformed, not about it being wrong.**
A parse-failure spike points at the model, the prompt or the JSON Schema. A rise in the
*Tool errors* column beside it points at the tool's description or its code. On `/ops` they
are deliberately two columns.

For context on what normal looks like: M0 measured **5/5** correctly-shaped tool calls and
M10 measured **13/13** across five prompt variants, with byte-identical arguments across
runs. Zero is the expected value here. Anything sustained is a change.

## Symptoms

- `/ops` → **Tool calls and parse failures**: one tool's rate above 10 %, the note under
  the table saying "One tool is over it right now".
- Grafana panel 7: the `recovered` split tells you how bad it is — `recovered="true"` means
  the fallback in `ollama.ts` is still rescuing the calls; `"false"` means it is not.
- Iterations per run drifting right (the model retrying itself), and `max_iterations`
  creeping up.
- `agent_runs.tool_parse_failure_count > 0` on recent runs.

## Diagnose

**The first question is always "what changed?"** This metric does not move on its own.

```bash
# 1. Which tool, how bad, and is the fallback still catching them?
curl -s -H "Authorization: Bearer $(grep '^METRICS_TOKEN=' .env | cut -d= -f2-)" \
  "http://localhost:3000/api/v1/ops/sli?hours=1" | jq '.tools'

# 2. Did the model tag change under us?  Compare the digest with what the last
#    known-good run recorded in agent_runs.model.
ollama list | grep gemma4

# 3. The actual failing arguments. `tool_args_raw` is preserved precisely for this.
psql "$DATABASE_URL" -c "
  select r.started_at, r.model, s.tool_name,
         left(coalesce(s.tool_args_raw, ''), 200) as raw,
         (s.raw->>'recovered') as recovered
  from agent_run_steps s
  join agent_runs r on r.id = s.run_id
  where s.kind = 'tool_call' and s.parse_ok is false
    and r.started_at > now() - interval '24 hours'
  order by r.started_at desc limit 20;"

# 4. For contrast: schema rejections, which are a *different* problem.
psql "$DATABASE_URL" -c "
  select s.tool_name, s.tool_result->>'code' as code, count(*)
  from agent_run_steps s
  join agent_runs r on r.id = s.run_id
  where s.kind = 'tool_result' and s.is_error
    and r.started_at > now() - interval '24 hours'
  group by 1, 2 order by 3 desc;"

# 5. Did a tool description or schema change recently?
git log --oneline -15 -- apps/api/src/model/tools/
```

Read the `raw` column. The shape of the failure is the diagnosis:

| `tool_args_raw` looks like            | Cause                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Prose describing the call             | The model stopped emitting native tool calls. → **Mitigate A**           |
| JSON with a trailing comma / comment  | Generation quality; often a temperature or model-version change.         |
| Truncated mid-object                  | `maxTokens` is cutting the call off. → **Mitigate C**                    |
| Empty, with `recovered: true`         | The fenced-JSON fallback is carrying the feature. → **Mitigate A**       |
| Valid JSON (so it is in query 4, not 3) | Not a parse failure at all — a schema mismatch. → **Mitigate B**       |

## Mitigate

**A — the model changed.** This is the most common cause and the fastest fix: roll the tag
back.

```bash
ollama pull gemma4:<previous-tag>
# then set OLLAMA_CHAT_MODEL in .env and restart the API (config is parsed at boot)
```

`agent_runs.model` records the tag used for every run, so the last known-good value is one
query away:

```bash
psql "$DATABASE_URL" -c "
  select model, count(*) filter (where tool_parse_failure_count > 0) as bad, count(*) as runs
  from agent_runs where started_at > now() - interval '30 days' group by 1 order by 3 desc;"
```

**B — a schema or description changed.** If query 4 is the one that moved, the fix is
almost always the tool's **description**, not its code: the model is being told the wrong
thing about what to send. Descriptions and JSON Schemas are derived from the Zod schemas in
`apps/api/src/model/tools/`, so there is exactly one copy to fix, and
`GET /api/v1/model/tools` shows what the model is actually being handed.

**C — the call is being truncated.** Raise `maxTokens`, or shorten the arguments the tool
needs. A tool whose arguments are long enough to hit a token limit is a tool with too many
parameters.

**Stop-gap:** none is needed. The loop's contract already contains this — a malformed call
becomes a `tool_result` with `is_error` and an explanation, and the model gets a turn to
fix it. Runs get slower, not broken. Resist the urge to add a retry: the loop already *is*
the retry, and a second one inside it would double the cost of the same failure.

## Verify

```bash
# Run the Module 5 exercise's canonical question a few times, then:
curl -s -H "Authorization: Bearer $(grep '^METRICS_TOKEN=' .env | cut -d= -f2-)" \
  "http://localhost:3000/api/v1/ops/sli?hours=1" | jq '.tools[] | {tool, calls, parseFailures, parseFailureRate}'
```

`parseFailures` back to 0 over at least five runs — **five, not one**. A parse failure that
happens a third of the time reads as "fixed" on a single successful run, and that is how
this specific bug gets closed twice.

The Grafana rule uses a one-hour window, so it will not clear immediately; the `/ops` table
is the faster feedback loop.

## Follow-ups

- Add the failing case to `apps/api/test/fixtures/ollama/` and assert it through
  `mapChatResponse` in `model-ollama.test.ts`. That suite exists because the M0 spike found
  the argument shape was an object on this model and a string in the documentation; a real
  malformed response is the most valuable fixture there is.
- If the fenced-JSON fallback (`recoverToolCallsFromContent`) rescued the calls, it worked
  — and it is also now load-bearing rather than defensive. Say so in the postmortem; a
  fallback nobody knows is carrying the feature is how the *next* change breaks it
  completely.
- If the cause was a model upgrade, add the model tag to the change checklist: a tag bump
  needs the tool-calling suite re-run, not just a green CI.
- Record the before/after in `docs/spike-notes.md`. Model-behaviour measurements are the
  thing this project keeps and cannot regenerate later.
