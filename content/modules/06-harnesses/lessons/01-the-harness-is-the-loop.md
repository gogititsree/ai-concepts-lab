---
slug: the-harness-is-the-loop
title: The harness is the loop
orderIndex: 1
estimatedMinutes: 12
---

# The harness is the loop

Stated as a specification, the harness is small enough to hold in your head. The state is
a list of messages. Each iteration: call the model with that list and the tool
definitions; if the reply contains tool calls, execute each one, append a `tool` message
per result, and go round again; otherwise the reply is the final answer and the loop
ends.

Everything else is error handling, and that is where the real work is. A tool name that
does not exist, arguments that do not parse, a tool that throws, a model that never stops
calling tools -- each one needs a decision. The useful default is to turn failures into
observations: append the error as a `tool` message and let the model try to recover,
while a hard iteration cap guarantees the loop terminates whatever happens.

You will write this yourself in the exercise, in a Web Worker, against a scripted fake
model whose three scenarios are chosen to break naive implementations: one that calls a
tool once and finishes, one that returns malformed arguments, and one that never stops.
Then lesson 3 lines your twenty lines up against what a harness like Claude Code adds --
permissions, sandboxing, streaming, context compaction, sub-agents, hooks -- and each of
those maps back to a specific line in your loop.
