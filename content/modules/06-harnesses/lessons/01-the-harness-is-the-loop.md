---
slug: the-harness-is-the-loop
title: The harness is the loop
orderIndex: 1
estimatedMinutes: 14
---

# The harness is the loop

Module 5 showed you a trace. This module makes you write the thing that produced it, and
the first step is to stop describing the loop in prose and write it down as a
specification — something precise enough that you could hand it to someone else and get
back code that passes the same checks.

## The specification

**State.** One list of messages. That is the entire state of an agent run. There is no
hidden memory, no session on the model's side, no "it remembers the last tool call". The
model is a function from a list of messages to one more message, and everything the agent
knows on iteration four is something the harness put in that list.

**One iteration.**

1. Call the model with the current message list and the tool definitions.
2. If the reply contains **no tool calls**, it is the final answer. Return it.
3. Otherwise append the assistant's reply to the list, tool calls and all.
4. For each tool call: execute it, and append exactly one message with `role: 'tool'`
   carrying the result.
5. Go to 1.

**Termination.** Step 2 is the only _successful_ exit. The other one is the iteration
cap, and it is not optional: nothing in the model guarantees step 2 ever happens. A model
that dislikes a tool result and tries again with a small variation will do that until
something outside it says stop.

In pseudocode, which is deliberately the same shape as `agentLoop.ts`:

```
messages = [system?, user]
for i in 1..maxIterations:
    reply = model.chat(messages, toolDefs)
    if reply has no tool calls:
        return { finalText: reply.content, messages }
    messages.push(assistant(reply))
    for call in reply.toolCalls:
        result = execute(call)          # never throws out of the loop
        messages.push(tool(call.name, result))
return { finalText: '', messages }      # hit the cap; no answer
```

Ten lines. The exercise is not hard because the loop is hard; it is hard because of the
three places the specification above is easy to read past.

## The three places people get it wrong

**"The reply has text, so it must be the answer."** A model can narrate what it is about
to do _and_ ask for a tool in the same turn: `"Let me work that out with the
calculator."` plus a `calculator` call. A loop that returns on non-empty content answers
with the narration and never computes anything. The stopping condition is the _absence of
tool calls_, not the presence of text. The scripted model's first scenario does exactly
this, on purpose.

**"The tool result is in a variable, so the model has it."** It does not. The model sees
nothing but the list you pass to the next `chat` call. A result that stays in a local
variable never happened as far as the model is concerned, and the usual symptom is an
agent that calls the same tool over and over: it asks, you answer somewhere it cannot
see, so it asks again. The result has to go back in as a message, and it has to be
`role: 'tool'` rather than `role: 'user'` — the role is what marks it as the answer to a
call the model itself made, rather than as something a human said.

**"If a tool fails, the run fails."** It does not have to, and it should not. An unknown
tool name, arguments the model did not format correctly, a tool that throws — all four
are _observations_. Turn each into a small JSON error object, append it as a `tool`
message, and let the model try again. This is the single design decision that most
changes how an agent behaves in practice: a harness that throws gives up on its first
malformed argument, and a harness that observes recovers on the next iteration about as
often as not. Module 5's `flaky_service` run is the measured version — the model read
the error, explained it in plain language and stopped, and the run's status was
`completed` because the _agent_ did the right thing even though the tool did not.

## What you are about to build, and where

The exercise gives you `runAgent(model, tools, userMessage, options)` to fill in, and it
runs your code in a **Web Worker in your own browser** — never on the server. That is
decision 4 in `docs/07-open-decisions.md`: learner-written code executing server-side is
a category of feature this app does not have. The worker gives you `model.chat`, two
tools, a `console` shim and your iteration cap, and nothing else. Your loop never talks
to the network; when it calls the model, the worker asks the page to make the call.

Two modes. The **scripted** one swaps in a deterministic fake model with three
scenarios — one that calls a tool then finishes, one that returns arguments that did not
parse, one that never stops — so the three auto-checks are instant, reproducible and
work with no model installed at all. The **real** one runs your loop against
`gemma4:latest` and files every step into the same `agent_runs` table the server loop
uses, so your trace opens in the same viewer at `/runs/:id`.

> **Where is this in the code?**
> The reference implementation you are reimplementing is
> `apps/api/src/model/agentLoop.ts`, and the pseudocode above is its header comment with
> the observability removed. The worker is
> `apps/web/src/workers/harnessRunner.worker.ts`; everything it does that is worth
> testing lives in `apps/web/src/features/exercises/harness/harnessCore.ts`, including
> the long comment on what its sandbox does and does not protect. The scripted model is
> `scriptedModel.ts` in the same folder, and it is worth reading before you start: it is
> forty lines, and knowing exactly what it will reply turns three opaque checks into
> three obvious ones.
