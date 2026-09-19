---
slug: reading-a-trace
title: Reading a trace
orderIndex: 3
estimatedMinutes: 15
---

# Reading a trace

An agent run leaves behind a row in `agent_runs` and an ordered list of rows in
`agent_run_steps`. That list is the trace, and reading one fluently is the practical
skill this module is for. When an agent misbehaves, the trace is where the answer is —
not in the final answer, not in the logs.

Below is a **real** run of the `compound-interest` task, against `gemma4:latest` on the
machine this course was written on. Nothing here is illustrative; these are the numbers
that came back.

## The run

```
system: You are a careful assistant with tools. Use the calculator tool for EVERY
        calculation, including ones that look easy — never do arithmetic in your head.
        Send one expression at a time, wait for the result, then give a plain final answer.
user:   A deposit of 2500 earns 7% interest compounded annually. What is the balance
        after 8 years? Give the number to two decimal places.
tools:  [calculator]
```

| #   | kind          | iter | tool         | latency   | tokens (p/c) | payload                                    |
| --- | ------------- | ---- | ------------ | --------- | ------------ | ------------------------------------------ |
| 0   | `model_call`  | 1    | —            | 23 548 ms | 227 / 27     | content empty                              |
| 1   | `tool_call`   | 1    | `calculator` | —         | —            | `{"expression": "2500 * (1 + 0.07)^8"}`    |
| 2   | `tool_result` | 1    | `calculator` | 2 ms      | —            | `{"result": 4295.465449579802, …}`         |
| 3   | `model_call`  | 2    | —            | 8 100 ms  | 303 / 17     | `"The balance after 8 years is $4295.47."` |
| 4   | `final`       | 2    | —            | —         | —            | same text                                  |

Run totals: `status=completed`, `iteration_count=2`, `tool_call_count=1`,
`tool_parse_failure_count=0`, 530 prompt tokens, 44 completion tokens,
`model_latency_ms_total=31 648`, wall clock 31 758 ms.

## Five things this trace says out loud

**The model produced no prose on its first turn.** Step 0's content is empty. When a model
decides to call a tool it usually says nothing else — the whole output of that 23-second
call was a tool name and eleven characters of JSON. If you only ever look at the final
answer, you never see that most of the work was spent deciding to ask for arithmetic.

**Tool execution is free and inference is not.** Step 2 took **2 ms**. Steps 0 and 3 took
**31.6 seconds** between them, which is 99.99 % of the run. Every optimisation instinct
you have from ordinary backend work points at the wrong line here. The only lever that
matters is _number of model calls_, which is to say: iterations.

**Prompt tokens grow, completion tokens do not.** 227 on the first call, 303 on the
second — the assistant's tool call and the tool's result were appended to the transcript
and re-sent. This is the cost curve of every agent loop: each iteration re-processes
everything before it. A ten-iteration run is not ten times one call; it is meaningfully
worse than that.

**Iteration numbers group the steps.** Steps 0–2 are iteration 1, steps 3–4 are iteration 2. One model call plus its tool calls and results is one pass. When you are looking at a
forty-step trace, collapsing it by iteration is how it becomes readable.

**The `final` step duplicates the last `model_call` content, deliberately.** It is one row
that says "this is the answer", so nothing downstream has to re-derive which step was the
end by scanning for the absence of tool calls.

## The same trace, when it goes wrong

Three shapes are worth recognising on sight.

**A schema rejection that recovered.** A `tool_call` with `parse_ok = true`, then a
`tool_result` with `is_error = true` and `{"code": "INVALID_ARGUMENTS", "details": [...]}`,
then another `model_call` — and a normal `final`. The model sent the wrong property name,
the server refused to execute, the complaint went back as an observation, and the model
fixed it. Cost: one extra iteration. This is the system working.

**A hallucinated tool.** `tool_call` naming something that does not exist, a `tool_result`
with `{"code": "UNKNOWN_TOOL", "details": ["available tools: calculator, …"]}`. The error
message lists what _is_ available, which is what usually lets the next turn recover.

**Arguments that were not JSON at all.** Here `parse_ok = false`, `tool_args` is null and
`tool_args_raw` holds the exact text the model emitted — often something truncated like
`{"expression": "12345 *`. That raw column exists precisely for this case: when parsing
fails there is no structured value, and the literal bytes are the only thing that explains
why. This is the one that increments `tool_parse_failure_count`, and it is a metric
because a rising parse-failure rate is how you find out a prompt or a model version has
drifted.

## Reading it in the app

The trace viewer on the right of the exercise is the same component that renders
`/runs/:id`, and the same one Module 6 will point at your own loop. Cards are colour-coded
by kind, error steps are visually distinct, and every `tool_args` and `tool_result` is
expandable JSON. While a run is live the cards arrive one at a time over Server-Sent
Events — which is not decoration: watching a 23-second gap before step 0 appears is how
"inference is the slow part" stops being a sentence in a lesson.

> **Where is this in the code?**
> The step rows are written by `apps/api/src/model/agentLoop.ts`, one `await` per step, as
> each happens — see the `emit` helper. The columns are defined in
> `apps/api/src/db/schema.ts` and specified in `docs/02-schema.md`. The streaming endpoint
> is `GET /model/runs/:id/events` in `apps/api/src/model/routes.ts`, with the SSE framing
> in `apps/api/src/model/sse.ts`. The viewer is
> `apps/web/src/features/runs/AgentTrace.tsx`. The numbers above are recorded in
> `docs/spike-notes.md` under "M10 measurements".
