---
slug: implement-run-agent
title: Implement runAgent
orderIndex: 2
estimatedMinutes: 16
---

# Implement `runAgent`

This lesson is the exercise's contract, the three checks it runs against you, and hints.
Not the solution — but everything you need to write one, and enough detail about the
checks that a red tick is never a mystery.

## The contract

```js
async function runAgent(model, tools, userMessage, options) { … }
```

You get four arguments and you return one object.

| you get                          | what it is                                |
| -------------------------------- | ----------------------------------------- |
| `model.chat(messages, toolDefs)` | resolves to `{ content, toolCalls }`      |
| `tools[name](args)`              | returns a JSON-able result, or **throws** |
| `userMessage`                    | the question, a plain string              |
| `options.maxIterations`          | your cap. Use it.                         |
| `options.toolDefs`               | the definitions to hand to `model.chat`   |

Each entry in `toolCalls` is `{ id, name, args, parseOk, rawArgs? }`. `args` is already
parsed, **except** when `parseOk` is `false`: then the model emitted something that was
not JSON, `args` is `null`, and `rawArgs` holds the literal text it produced.

You return `{ finalText, messages }`. `finalText` is the answer as a string, empty if you
ran out of iterations without one. `messages` is the transcript you built — the real
one, the array you actually passed to the last `chat` call. Two of the three checks read
it, so returning a tidied-up copy is a good way to fail a check your loop deserved to
pass.

One addition to the signature as `docs/04-curriculum.md` writes it: `toolDefs` rides
along in `options`, because you have to pass _something_ as the second argument to
`model.chat` and a global would have been worse. If you omit that second argument
entirely, the worker fills it in.

## What the tools do

Two of them, both implemented in your browser, neither one on the server:

- `calculator({expression})` — real arithmetic, no `eval`, returns
  `{expression, result}`. Throws a readable `Error` if `expression` is missing or is not
  a string, which is exactly what happens when the model's arguments did not parse.
- `get_current_time({})` — returns an ISO timestamp and a weekday in UTC.

A tool **throws** rather than returning `{error: …}`, and that is the pedagogy rather
than an accident. A tool that returned an error object would let a loop with no `try`
around it sail through the malformed-arguments scenario, and the whole point of that
scenario is that your loop has to survive a call it cannot make.

## The three checks

Completion needs these three. The fourth task, a real run against Gemma, is encouraged
and never required — local inference is 19–32 seconds for a two-call run when warm and
about a minute cold, and a module you cannot finish without a GPU is a module you cannot
finish on a train.

Each check runs your loop against one or two scripted scenarios. The scripted model is
fully deterministic: no timers, no randomness, no clock, and its reply depends only on
the scenario and on how many times you have called it. It deliberately **ignores your
transcript**, which is what lets one bug fail one check instead of three.

### `check-terminates`

Scenario `single-tool`. The fake answers your first call with

```
content:   "Let me work that out with the calculator."
toolCalls: [calculator {expression: "17 * 23"}]
```

and every call after that with `"17 * 23 = 391."` and no tool calls. The check passes
when your `finalText` contains **391**.

_Hint._ The first reply has text in it. If your loop treats "the model said something" as
"the model is done", you will return the narration and this check will tell you exactly
what you returned instead.

### `check-appends-tool-message`

Two scenarios, because the check has two halves.

First, in `single-tool`: your returned `messages` must contain a message with
`role: 'tool'`, it must come after an `assistant` message, and its content must carry the
calculator's result (the digits `391` have to be in there somewhere —
`JSON.stringify(result)` is the obvious way).

Second, in `malformed-args`: the fake's first reply asks for `calculator` with
`parseOk: false`, `args: null` and `rawArgs: '{"expression": "17 * 23'`. Your loop must
**not** crash, must append a `tool` message describing the failure, and must go round
again — at which point the fake gives you the answer and you finish normally.

_Hint._ Both signals are there so either style works: check `call.parseOk === false`
before you execute, or just wrap the execution in `try`/`catch` and let the tool's own
thrown message become the observation. The server's loop does both, and so can you.

### `check-max-iterations`

Scenario `never-stops`. Every reply asks for `calculator` again, for ever, with no text.
The check passes when your loop made **exactly `maxIterations`** model calls and then
returned. Not more, not fewer, and not "hung".

_Hint._ `while (true)` passes the other two checks. This one is where it is caught —
after a few dozen calls the scripted model gives up and tells you how many you made. If
your count is one out, you are probably calling the model once more after the cap, or
counting iterations from zero and comparing with `<=`.

## Running it

**Run scripted checks** runs all three scenarios in three fresh workers and is over
before you have let go of the mouse. If the elapsed counter starts climbing, your loop is
spinning without awaiting anything, and the page will terminate the worker after sixty
seconds — which is the only way to stop a loop like that, because nothing inside a
JavaScript thread can interrupt one.

**Run against Gemma** opens a real `harness` run, drives your loop against the model and
reports each tool call and the final answer into `agent_run_steps`. The trace appears on
the right and at `/runs/:id`, next to the traces the server's own loop produced in Module 5. `console.log` from your code goes to the console panel; it is the only debugger you
get inside a worker, and it is enough.

Your code is saved as you type and restored when you come back.

> **Where is this in the code?**
> The checks are pure functions in
> `apps/web/src/features/exercises/harness/checks.ts`, and their failure messages are
> the ones you see under a red tick. The scenarios are `scriptedModel.ts`. The reference
> solution is `reference.ts` in the same folder — it is in the bundle, so you _can_ read
> it, and `apps/web/test/harnessCore.test.ts` runs it plus three deliberately broken
> variants against all three checks to prove each variant fails exactly one. That test
> is the reason you can trust a green tick.
