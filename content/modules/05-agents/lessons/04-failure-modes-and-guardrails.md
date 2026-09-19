---
slug: failure-modes-and-guardrails
title: Failure modes and guardrails
orderIndex: 4
estimatedMinutes: 15
---

# Failure modes and guardrails

Every failure below is reachable in the exercise, has a code path in this repository, and
leaves a distinctive shape in the trace. That is the point of the list: these are not
hypotheticals to guard against in principle, they are things that happen on a Tuesday.

## Hallucinated tool names

The model asks for `search_web` when the only tools attached are `calculator` and
`get_current_time`. It is not lying; tool names are just tokens, and a plausible one is
easy to generate.

**Guardrail: an allow-list, checked by name at execution time.** In this app the set of
catalog tools is an enum in shared code, so a name that is not in it cannot reach an
implementation — there is no dynamic lookup to poison. The unknown call becomes a
`tool_result` with `UNKNOWN_TOOL` and a `details` line naming what _is_ available, which
is usually enough for the next turn to recover.

## Malformed and invalid arguments

Two different failures that people conflate:

- **Not JSON.** The argument string is truncated or has a stray character. `parse_ok` is
  false, `tool_args_raw` holds the literal text, and `tool_parse_failure_count` goes up.
- **Valid JSON, wrong shape.** `{"expr": "2+2"}` where the schema says `expression`.
  `parse_ok` is true; the _server's_ validation rejects it.

**Guardrail: validate server-side, always, and feed the error back.** The model was given
the schema, and that is a hint, not a constraint. The validation error goes into the
conversation as a `tool` message so the model can correct itself — which it usually does,
at the cost of one iteration.

## Infinite loops

The model calls a tool, dislikes the result, calls it again with a small variation, and
repeats. Nothing in the model counts iterations.

**Guardrail: a maximum-iteration cap** — 8 by default here, hard-capped at 15 — **plus a
wall clock** (5 minutes) **and a per-tool timeout** (10 seconds). Hitting the cap is its
own status, `max_iterations`, not an error: it is a bounded outcome, and counting how
often it happens is more useful than logging it as a crash.

The three guardrails are not interchangeable. A cap does not save you from one tool that
hangs; a per-tool timeout does not save you from twelve fast iterations that go nowhere.

## Prompt injection through tool results

A tool returns text, that text goes into the model's context as a `tool` message, and the
model has no reliable way to distinguish "data I was given" from "instructions I was
given". A glossary lookup that surfaces a lesson containing the words _ignore your
previous instructions_ is a real, boring version of this.

**Guardrail: bound the blast radius, not the wording.** Telling the model to ignore
injections is a mitigation, not a defence; the injected text is competing on equal terms
with your system prompt. What actually holds is that the agent can only do what its
attached tools allow. An agent with a calculator and a clock cannot exfiltrate anything
regardless of how convincing the injected sentence is. This is why "what tools are
attached" is a security decision and not a convenience one.

## Over-broad tools

One `run_shell(command)` tool is more dangerous than fifty narrow ones, and — separately —
harder for the model to use correctly. A wide tool pushes the decision of _what to do_
into a free-text argument the schema cannot constrain. Narrow tools with enums are both
safer and more reliable, which is an unusually happy alignment.

## A tool that is simply broken

Networks fail. The exercise has `flaky_service`, which always does.

**Guardrail: the error is an observation, not an exception.** A thrown tool becomes a
`tool_result` with `is_error` and the loop continues. In a real run of that task the model
read the error, reported it to the user and stopped — status `completed`, because the
_agent_ worked correctly even though the tool did not. Distinguishing "the run failed"
from "a tool failed and the agent handled it" is a distinction your metrics need too.

## Idempotency

If a tool can be called twice — and it can, because retries and loops exist — calling it
twice must be safe. Read-only tools are trivially idempotent, which is one more reason the
catalog here is all reads. The moment a tool writes something, it needs a caller-supplied
key or a natural one, and that is a design decision to make before the tool exists rather
than after the second charge on someone's card.

> **Where is this in the code?**
> Each guardrail is a named piece of `apps/api/src/model/agentLoop.ts`: the allow-list
> lookup is `byName.get(call.name)`, schema validation is `tool.parse(...)`, the
> per-tool budget is `withTimeout(...)`, and the cap, the wall clock and cancellation all
> converge on one `AbortController` with a `stopped.reason` that says which of them fired
> — so `cancelled` and `RUN_TIMEOUT` stay distinguishable in the data. The constants live
> in `packages/shared/src/model.ts` (`AGENT_MAX_ITERATIONS_DEFAULT`,
> `AGENT_MAX_ITERATIONS_CAP`, `AGENT_WALL_CLOCK_MS`, `TOOL_TIMEOUT_MS`). The tool that
> always fails is `flaky_service` in `apps/api/src/model/tools/catalog.ts`. Every branch
> above has a test in `apps/api/test/agent-loop.test.ts` asserting the exact sequence of
> step kinds it leaves behind.

> **What to measure**
>
> These are the metrics M14 will implement. Each one exists because a failure above is
> invisible without it.
>
> - **`agent_runs_total{status}`** — the ratio of `completed` to `failed`,
>   `max_iterations` and `cancelled`. A rising `max_iterations` share is a prompt or a
>   tool description degrading, and it will never show up as an error.
> - **`agent_run_iterations`** (histogram) — iterations per run. The distribution matters
>   more than the mean: a bimodal one means two populations of question, and the tail is
>   where the cost is.
> - **`tool_call_parse_failures_total{tool, recovered}`** — the leading indicator that a
>   model version, a prompt or a schema has drifted. `recovered` separates "we dug the
>   call out of prose" from "we gave up".
> - **`model_call_duration_seconds`** (histogram, p50/p95) — inference is 99.99 % of a
>   run's wall clock, so this _is_ the latency SLI. Measured per call, not per run, or the
>   iteration count hides inside it.
> - **Tokens per run, prompt and completion separately.** Prompt tokens grow with
>   iterations and are the real cost driver. A measured example: attaching all six tools
>   instead of one took the first call's prompt from 227 tokens to 1052 and its latency
>   from ~18 s to ~71 s. Tool descriptions are not free.
> - **Tool-error rate per tool** (`tool_result.is_error`) — one tool failing is an outage;
>   every tool failing is your network.
> - **Run wall clock versus `model_latency_ms_total`.** When they diverge, the time is
>   going somewhere other than inference, and that somewhere is a bug.
