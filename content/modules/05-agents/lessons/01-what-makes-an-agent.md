---
slug: what-makes-an-agent
title: What makes an agent
orderIndex: 1
estimatedMinutes: 12
---

# What makes an agent

An agent is not a different kind of model. It is the same chat model from Module 4, called
in a loop, by a program that is willing to act on what it says. That program is the agent.
The model is a component inside it.

Here is the whole idea, with nothing left out:

```
messages = [system, user]
repeat:
    reply = model.chat(messages, tools)
    if reply has no tool calls:
        return reply.content            # the final answer
    messages.append(reply)
    for each call in reply.tool_calls:
        result = run_the_tool(call)     # your code, not the model's
        messages.append({role: "tool", content: result})
```

Four lines of control flow. Everything else in this module — the guardrails, the trace,
the failure modes — is consequences of those four lines meeting a component that is
probabilistic.

## The model never runs anything

This is the sentence to keep. When a model "calls a tool", what actually happens is that
it emits some text: a name and a JSON object. That is all. It has no file system, no
network, no shell. Your code reads that text and decides whether the named tool exists,
whether the arguments are valid, whether the user is allowed to do that, and whether to
execute it at all.

Every guardrail you will ever want lives in that gap. Allow-lists, schema validation,
permission prompts, rate limits, sandboxes, timeouts — all of them are your code choosing
not to act on something the model asked for. And the corollary matters just as much: a
capability you do not attach is a capability the agent does not have, no matter how
convincingly it asks. An agent with only a calculator attached cannot delete a file
however thoroughly it is talked into wanting to.

## Why the transcript has to carry the result

The model is stateless between calls. It does not remember that it asked for the
calculator a moment ago; the only thing it will ever know about this conversation is the
message list you send on the next request. So after your code runs a tool, it has to put
the result back into the transcript, and it has to be marked as a tool result rather than
as something the user said — hence the fourth role, `tool`, alongside `system`, `user` and
`assistant`.

That is why a long agent run gets slower and more expensive with every iteration: the
whole conversation, tool results and all, is re-sent and re-processed each time. Six
iterations is not six model calls' worth of work, it is six increasingly long ones. The
trace in this module shows prompt tokens per step, and watching that number climb is the
most concrete version of "context is a budget" you will see in this course.

## Stopping is the hard part

Nothing in the model guarantees it will ever stop asking for tools. It is not being
obstinate; it has no concept of how many times it has been round this loop. A model that
gets an unhelpful tool result will often ask for the same tool again with slightly
different arguments, forever, and the loop will let it — because the loop is `repeat`.

So a real loop has stopping conditions bolted to it, and they are not optional extras:

- **A maximum-iteration cap.** This app's default is 8, hard-capped at 15. Reaching it is
  not an error; it is a bounded outcome with its own status, `max_iterations`.
- **A wall-clock budget.** Five minutes for the whole run. On local hardware one model
  call can take 45 seconds, so an eight-iteration run can plausibly need four minutes —
  and anything past that is a run nobody is still watching.
- **A per-tool timeout.** Ten seconds. A tool that hangs must not hang the run.
- **Cancellation.** The learner can stop the run, and the signal reaches all the way down
  to the HTTP request to Ollama, so cancelling stops the inference rather than just
  stopping the page from listening to it.

## What the exercise does

In the exercise, the loop runs **on the server**. You pick the tools, write the system
prompt, and press Run; the server does the iterating and streams each step to your browser
as it happens, over Server-Sent Events. In Module 6 you will write the loop yourself, in a
Web Worker in your own browser, and the same trace viewer will show your version. Seeing
the two side by side is the point of splitting them across two modules: the loop is not
magic, and after Module 6 you will have written one.

> **Where is this in the code?**
> `apps/api/src/model/agentLoop.ts` is the pseudocode above, made real — about two hundred
> lines, and most of them are the error paths rather than the loop. The tools are in
> `apps/api/src/model/tools/`, one file per concern: `calculator.ts` is the expression
> parser, `catalog.ts` is the five real tools plus one that always fails, `mock.ts` is the
> learner-defined ones. The loop's HTTP face is `apps/api/src/model/routes.ts`
> (`POST /model/runs` and the SSE endpoint), and every step it writes lands in
> `agent_run_steps` (`docs/02-schema.md`).
