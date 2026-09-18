---
slug: what-makes-an-agent
title: What makes an agent
orderIndex: 1
estimatedMinutes: 10
---

# What makes an agent

An agent is not a different kind of model. It is the same chat model, called in a loop, by
a program that is willing to act on what it says. Prompt goes in; if the reply asks for a
tool, the program runs the tool and appends the result as another message; then it calls
the model again. When the reply contains no tool call, that is the final answer.

The key point, and the one that survives every hype cycle: the model never runs anything.
It emits text that names a tool and some arguments. Your code decides whether that tool
exists, whether the arguments are valid, and whether to execute it at all. Every
guardrail you will ever want -- allow-lists, schema validation, permission prompts,
timeouts -- lives in that gap.

The loop needs stopping conditions, because nothing in the model guarantees it will ever
stop asking. A maximum-iteration cap, a wall-clock timeout, and an error path that feeds
failures back as observations are the minimum. The trace viewer in this module shows each
of those states explicitly, and `agent_run_steps` in the database is where they are kept
long enough to ask questions about them later.
