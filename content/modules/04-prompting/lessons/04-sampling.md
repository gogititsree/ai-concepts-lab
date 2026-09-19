---
slug: sampling
title: 'Sampling: temperature, top-p, seed'
orderIndex: 4
estimatedMinutes: 12
---

# Sampling: temperature, top-p, seed

A language model does not output text. It outputs a vector of logits — one real number per
vocabulary token — and something else turns that into a choice. That something is the
sampler; it is not part of the model, and it is where the knobs live.

## Temperature reshapes the distribution

Logits become probabilities through a softmax, with temperature $T$ dividing on the way in:

$$
p_i = \frac{\exp(z_i / T)}{\sum_j \exp(z_j / T)}.
$$

Read it as a contrast control. Large $T$ shrinks the gaps between logits and flattens the
distribution, so unlikely tokens get a real chance. Small $T$ exaggerates them. As
$T \to 0$ the distribution collapses onto the highest-logit token — greedy decoding, the
sampler no longer sampling.

Two consequences people get backwards:

- **Temperature controls variance, not quality.** Raising it does not make the model more
  creative; it makes it more willing to be wrong in interesting ways. You have widened the
  tail you draw from, not improved the distribution.
- **Temperature 0 is not "accurate mode".** It is "always pick the argmax" — a good default
  for extraction and classification, a bad one anywhere you would run a prompt twice and
  compare.

## Top-p truncates it

Nucleus sampling sorts tokens by probability, walks down the list accumulating mass until
it passes $p$, and discards everything below. With `top_p = 0.9` you sample from the
smallest set of tokens covering 90 % of the probability mass.

The set is _adaptive_: where the model is confident the nucleus may be two tokens, where it
is uncertain it may be two hundred. `top_k` keeps the same number regardless, which is why
top-p is the more common default.

The two compose in the obvious order — reshape, then truncate — and turning both up at once
is usually a mistake. Reasonable starting points: extraction at $T = 0$; explanation around
$T = 0.7$ with `top_p = 0.9`; brainstorming higher, judged over several runs.

## Seed, and the limits of reproducibility

A fixed seed makes the pseudo-random draws identical, so the same request produces the same
output. Set a seed and re-run the exercise: you should get the same text, token for token.

Now notice what "same" is conditional on: the same weights, quantisation, runtime version,
batching behaviour and often the same hardware. Floating-point addition is not associative,
so a different reduction order in a kernel can flip a logit comparison and, several tokens
later, produce a different sentence. A seed buys reproducibility on one machine, today.

Which is the setup for the question this module's quiz asks.

## Why the `FakeProvider` exists

You need a test that asserts the agent loop terminates, that a tool result is appended as a
`tool` message, that a parse failure is recorded. None of those assertions are about the
model. All of them are about your code.

Running them against a real model makes them slow (6–45 seconds per call), non-deterministic
and — decisively — **impossible in CI**, which has no GPU and no Ollama. Temperature 0 and a
fixed seed do not rescue that: they stabilise output on the machine that has the model,
which CI is not.

So the test double is a first-class implementation of the same interface:

```ts
provider.chat({ messages, options: { scenario: 'tool-call-malformed-args' } });
```

A scenario table, selected by name, covering the branches the code under test needs:
`plain-answer`, `structured-valid`, `structured-invalid` (prose despite a schema — the real
failure, reproduced on demand), `tool-call-once`, `tool-call-malformed-args`,
`tool-call-unknown-tool`, `tool-call-never-stops` (so the max-iteration guard is exercised
rather than hoped for), `slow`, and two that throw.

Note what is gained beyond speed: **failure modes become reachable**. "The model emitted
arguments that are not valid JSON" is rare enough that you would never catch it in a test
run, and common enough in production to matter. With a fake it is one string.

And the trade, honestly: a test passing against the fake proves your code handles the
responses you _imagined_. That is why this milestone also ends with a manual run against
the real model, recorded in `docs/spike-notes.md`.

> **Where is this in the code?**
> `apps/api/src/model/fake.ts` is the scenario table; `FAKE_SCENARIOS` at the top is the
> whole list. The sampling options are mapped to the provider's own spelling in
> `toOllamaOptions` (`apps/api/src/model/ollama.ts`): `temperature`, `topP` → `top_p`,
> `maxTokens` → `num_predict`, `seed` → `seed`. `MODEL_PROVIDER=fake` in `apps/api/vitest.*`
> config is what makes the whole suite runnable on a laptop with nothing running.

> **What to measure**
>
> - **Variance across runs at a fixed temperature.** Run the same prompt five times and
>   look at the spread, not the best one. This is the number that tells you whether a
>   change helped.
> - **Whether a seed actually pins the output** on your setup. Verify it; do not assume it.
> - **Completion tokens against temperature.** Higher temperatures often produce longer,
>   more meandering answers, so a knob that looks free costs latency.
> - **Test suite wall-clock.** If your model tests are slow enough that you stop running
>   them, they have a pass rate of zero.
