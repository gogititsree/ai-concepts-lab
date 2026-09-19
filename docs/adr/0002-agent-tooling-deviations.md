# ADR 0002 — Three deviations from the M10 agent-tooling design

- **Status:** accepted
- **Date:** 2026-09-19 (M10, agent loop and Module 5)
- **Deviates from:** `docs/01-architecture.md` → "The agent loop (server-side, Module 5)" and the API route table

## 1. A sixth catalog tool, `flaky_service`

`docs/01` lists five tools (`calculator`, `get_current_time`, `unit_convert`,
`lookup_glossary`, `fake_weather`). Module 5's `observe-failure` task needs a tool that
returns an error so the learner can watch the loop feed the failure back as an observation.

The alternatives were worse:

- **Break a real tool.** Makes the other three tasks intermittently fail for reasons the
  learner did not cause.
- **A mock tool returning `{"error": ...}`.** That is a *successful* tool call carrying an
  error-shaped payload. It teaches the opposite of the distinction the trace viewer draws
  between `tool_result` and `tool_result` with `is_error`, which is the whole point of the
  lesson.

So `flaky_service` exists, always throws, and says so in its own description. Named
honestly enough that a learner reading the catalog understands it is a teaching device.

## 2. `parse_ok` counts only provider-side parse failures

`agent_runs.tool_parse_failure_count` increments only when the *provider* handed back
arguments that were not valid JSON. Arguments that parse but fail the tool's Zod schema are
recorded as a `tool_result` step with `is_error` and code `INVALID_ARGUMENTS`, and do **not**
increment the counter.

The reason is the metric it feeds. M14 exports `tool_call_parse_failures_total`, and an
operator reading that name expects "the model emitted malformed JSON", which is a model or
prompt problem. A schema rejection is a different failure with a different fix (usually the
tool's description), and blending the two would make the metric unactionable. Both are
visible in the trace; only one is in the counter.

## 3. `GET /model/tools` added to the route table

Not in `docs/01`. The Module 5 tool picker needs each catalog tool's description and JSON
Schema to render, and those are derived from the Zod schemas at module load on the server.

The alternative is copying the descriptions and schemas into the exercise's `config`, which
reintroduces exactly the drift the derive-from-Zod design removes: two copies of a schema,
one of which the validator does not read. The endpoint is read-only and requires a session
like the rest of the API.

## Consequence

`docs/01-architecture.md` is now out of date on these three points. It is left as the
design-time record; this ADR is the current truth, per the process in `CLAUDE.md`.
