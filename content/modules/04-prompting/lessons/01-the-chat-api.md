---
slug: the-chat-api
title: The chat API
orderIndex: 1
estimatedMinutes: 12
---

# The chat API

From the outside, a chat model is a pure function: a list of messages in, one more message
out. There is no session on the far side, no memory, no connection being held open. What
looks like the model "remembering" the last thing you said is the entire transcript being
posted again, from scratch, every single turn.

Internalising that one fact explains most of what follows, so it is worth making concrete.

## Four roles, and what each is for

**`system`** is the standing instruction: who the assistant is, what it must refuse, what
shape the output should take. It goes first and it is resent on every call, which means
every token of it is paid for every time. A 500-token system prompt on a 20-turn
conversation costs 10,000 tokens of input.

**`user`** is the request. Anything from outside your own code — a document, a search
result, a comment from the internet — belongs here, clearly delimited, never concatenated
into the system prompt. Lesson 2 shows what happens when you ignore that.

**`assistant`** is what the model said last time. You send its own previous replies back to
it; that is the "memory".

**`tool`** carries the result of a function the model asked you to run. The model does not
execute anything. It emits a _request_ — a name and some JSON arguments — your server runs
the function, and you append the result as a `tool` message and call again. Module 5 builds
an agent out of nothing but that loop.

## The context window is a budget, not a memory

Because everything is resent, the context window behaves like a spending limit rather than
a recollection. The model on this machine advertises a 131,072-token window, which sounds
infinite until you notice that generation is $O(n)$ per token against a growing prefix, so
a long conversation gets slower as well as dearer. When the transcript approaches the limit
something has to be dropped or summarised. Nothing in the protocol does that for you.

Two counters come back with every response and they measure exactly this: `prompt_eval_count`
(how many tokens went in) and `eval_count` (how many came out). The exercise shows both.

## The seam: `ModelProvider`

Talking to a model is an HTTP call to somebody else's service with somebody else's field
names. Left unmanaged, that vocabulary leaks: a `num_predict` here, a `keep_alive` there,
and eighteen months later swapping providers means touching forty files.

So this app defines one interface and allows exactly one directory to know what is behind
it:

```ts
interface ModelProvider {
  readonly name: 'ollama' | 'fake' | 'none';
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  embed(texts: string[], model?: string): Promise<number[][]>;
  health(): Promise<{ ok: boolean; models: string[]; detail?: string }>;
}
```

Three implementations sit behind it. `OllamaProvider` is the real local model.
`FakeProvider` returns scripted responses and is what continuous integration runs, because
CI has no GPU and no Ollama — without it, none of this code would be tested at all.
`NoneProvider` fails every call with `MODEL_UNAVAILABLE`, which is what the deployed copy
of this app runs, and is why you may be reading this with a banner at the top of the
exercise telling you to run it locally.

That is not a workaround. "The dependency is absent" is a supported configuration, handled
by a real class, so the failure is a banner rather than a stack trace. Graceful degradation
is cheaper to build on day one than to retrofit.

## What actually goes over the wire

When you press Run, the browser posts a `ChatRequest` to `POST /api/v1/model/chat`. The
server maps it onto Ollama's own shape — roles stay, `maxTokens` becomes `num_predict`,
`topP` becomes `top_p` — posts it with `stream:false`, and maps the reply back. Then it
writes an `agent_runs` row with one `model_call` step and one `final` step, whether the
call succeeded or not.

Logging every call is not paranoia. It is what makes the trace viewer possible in Module 5,
what `/ops` aggregates in the SRE module, and what lets you answer "why was that answer
different yesterday" at all.

> **Where is this in the code?**
> `packages/shared/src/model.ts` holds the provider-neutral types — nothing in that file
> mentions Ollama. `apps/api/src/model/provider.ts` is the interface and the factory that
> picks an implementation from `MODEL_PROVIDER`. `apps/api/src/model/ollama.ts` is the only
> file in the repository allowed to know the port number, and
> `apps/api/src/model/routes.ts` is the HTTP route plus the run logging.

> **What to measure**
> Every response the exercise shows you carries four numbers. Learn to read them together.
>
> - **Prompt tokens.** What you spent on input. If this grows every turn, your transcript
>   is growing; that is normal, and it is also your bill.
> - **Completion tokens.** What the model generated. The dominant cost of latency on a
>   local model — see lesson 3 for a case where it doubled for no visible benefit.
> - **Latency.** Wall clock, measured by the adapter rather than reported by the model. On
>   this hardware, 6–45 seconds warm; the first call after an idle period adds 20–40
>   seconds of model loading, which is why the provider sends `keep_alive: '10m'`.
> - **The run id.** Every call is a row you can go back and read. If you cannot point at
>   the trace for a call that misbehaved, you are debugging from memory.
