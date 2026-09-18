---
slug: the-chat-api
title: The chat API
orderIndex: 1
estimatedMinutes: 10
---

# The chat API

From the outside a chat model is a function from a list of messages to one more message.
Each message has a role -- system, user, assistant, tool -- and the model sees all of them
concatenated, every single call. There is no session on the far side: what looks like
memory is just the transcript being resent.

The system message is where you put the things that should hold for the whole
conversation: who the assistant is, what it must refuse, what shape its output should
take. The user messages carry the request. Assistant and tool messages are how earlier
turns, and the results of any tools that ran, get folded back into the input for the next
call. Module 5 builds an agent out of exactly that mechanism.

Because everything is resent, the context window is a budget rather than a memory. Every
token of the system prompt is paid for on every request, and when the transcript grows
past the window something has to be dropped or summarised. This app hides the provider
behind a `ModelProvider` interface with `chat`, `embed` and `health`, so nothing outside
`apps/api/src/model/` knows whether it is talking to Ollama, a fake, or nothing at all.
