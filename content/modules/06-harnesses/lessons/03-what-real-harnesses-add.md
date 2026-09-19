---
slug: what-real-harnesses-add
title: What real coding-agent harnesses add
orderIndex: 3
estimatedMinutes: 18
---

# What real coding-agent harnesses add

Your loop is about twenty lines. A coding agent like Claude Code is the same twenty lines
with roughly ten more concerns wrapped around them. This lesson is a tour of those ten,
and every one of them is pinned to the exact line of your loop where it would go — because
the useful realisation is not "production is complicated", it is "production is _this_
loop, plus a list of specific decisions, each of which you can now name".

Use this skeleton as the map:

```
 A  messages = [system, user]
 B  for i in 1..maxIterations:
 C      reply = model.chat(messages, toolDefs)
 D      if no tool calls: return reply.content
 E      messages.push(assistant(reply))
 F      for call in reply.toolCalls:
 G          result = execute(call)
 H          messages.push(tool(result))
```

## System prompt and environment context — line A

Your line A is `[{role:'user', content: userMessage}]`. A coding harness builds a much
larger line A before the user has typed anything: the operating system, the working
directory, the current git branch and whether the tree is dirty, today's date, the
project's conventions. Some of it is assembled by running commands; some is read from
files the project commits. It is all just text prepended to the transcript, and it is the
cheapest large improvement available — an agent that has to _ask_ what directory it is in
burns an iteration and often guesses instead.

## A tool set with a permission model — lines F and G

Your `tools` object has two entries and both are safe by construction. A coding harness
has read, edit, search, shell and web tools, and shell alone can do anything the user
can. So between `for call in reply.toolCalls` and `execute(call)` there is a decision
point: _is this call allowed?_ Allowed calls proceed; the rest stop and ask the human,
who can approve once or add a rule. The prompt is not there because the model is
malicious — it is there because the model is **confident**, and the cost of a wrong
`rm -rf` is not symmetric with the cost of one confirmation. Your loop has the same slot;
it is simply always `yes`.

## Sandboxing — around line G

Permissions decide _whether_; sandboxing bounds _what happens anyway_. Filesystem access
scoped to the project directory, network access denied by default, a container or a
seccomp profile for the shell. Your exercise has a toy version of this and it is honest
about its limits: your code runs in a Web Worker, which protects the _page_ from your
infinite loop and keeps the server out of reach, but the worker is same-origin — one
`Function('return this')()` and you have the real global back. That is fine here because
the code is yours. It stops being fine the moment a harness runs code someone else wrote,
and that is the line at which "a worker" has to become "a different origin" or
"a container".

## Streaming and partial output — line C

Your `model.chat` returns when the whole reply is ready. A real harness streams tokens,
so text appears as it is generated and tool calls are dispatched as soon as their
arguments are complete. This matters more than it sounds: on this machine one model call
is 9–25 seconds warm, so the difference between streaming and not is the difference
between an agent that is visibly working and one that looks hung. It also makes cancel
meaningful mid-generation.

## Context management and compaction — between lines H and C

This is the one your loop cannot survive without, in any long session. Every iteration
appends: an assistant turn, one `tool` message per call, and tool results are the big
ones — a file read is thousands of tokens. The window fills, and then the next `chat`
call fails or silently truncates.

The fix goes exactly at the top of the loop, before line C: if the transcript is over
some threshold, summarise the older part into one message and keep the recent turns
verbatim. Variants are dropping the _contents_ of superseded file reads while keeping the
fact that they happened, and keeping the first user message pinned no matter what.
Compaction is lossy and it is where an agent "forgets" something you told it an hour
ago — which is why real harnesses also let you write things down somewhere compaction
cannot reach.

## Retries and backoff — around line C

You have one failure mode for a model call: it throws and your loop stops. A real harness
distinguishes transient from permanent. A 429 or a 503 gets an exponential backoff and a
retry; a 400 does not, because retrying a malformed request just produces the same 400
more slowly. The retry belongs around the call and **not** around the iteration — going
round the whole loop again re-executes the tools, and tools are not all idempotent.

## Sub-agents — a second, nested loop at line G

Sometimes a tool call is best answered by _another_ agent: "find where sessions are
validated" is a search task with its own iterations. So a harness gains a tool whose
implementation is a fresh `runAgent` with a narrower goal, its own tools and its own cap,
and whose _result_ — the answer, not the transcript — is appended to the parent as one
`tool` message.

That last part is the whole design. The sub-agent's twenty intermediate turns must not
be merged into the parent's context: they would consume the window the parent needs, and
most of them are dead ends the parent should not be reasoning about. A sub-agent is a
context-window budget with a job.

## Hooks — before line G and after line H

Deterministic code that runs at fixed points in the loop: before a tool call (block it,
rewrite it, log it) and after one (format the file that was just edited, run the
type-checker, append its output). Hooks are how a team encodes "we always run the
formatter" as a _rule_ rather than as a sentence in the prompt that the model follows
most of the time. Anything you would be annoyed to see skipped belongs in a hook, not in
a system prompt.

## Persistent memory files — read into line A, written at line G

Compaction forgets; a file does not. A project-level instructions file, read into the
system prompt at the start of every session, is the harness's long-term memory — and
because it is a file in the repository it is reviewable, diffable and shared with the
team. This course has one: `CLAUDE.md` at the root of this repo.

## Structured stop reasons — line D, and the loop's exit

Your loop has two exits: an answer, or the cap. A real harness has a small enumeration —
finished, needs user input, hit the token budget, cancelled, refused, tool error the model
could not recover from — and the caller branches on it. This is not bookkeeping: "needs
input" should prompt, "budget" should offer to continue, "cancelled" should not be
reported as a failure. The server loop in this app has four
(`completed`, `failed`, `cancelled`, `max_iterations`) and the next lesson is about why
those four are the difference between a dashboard and a shrug.

> **Where is this in the code?**
> The four this app implements are all in `apps/api/src/model/agentLoop.ts`: the
> allow-list before execution (`byName.get(call.name)`) is the skeleton of a permission
> model, `withTimeout` is the per-tool budget, the `AbortController` with its
> `stopped.reason` is cancellation plus a wall clock, and the return `status` is the stop
> reason. Compaction, streaming, retries, sub-agents and hooks are **not** implemented
> here, deliberately — Module 6 is about being able to say where each would go, which is
> the knowledge that transfers.
