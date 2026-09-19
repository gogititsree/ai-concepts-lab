---
slug: structured-output
title: Structured output, and a quirk found by measuring
orderIndex: 3
estimatedMinutes: 15
---

# Structured output, and a quirk found by measuring

Prose is fine for a person and terrible for a program. The moment an answer has to be read
by code you need a shape you can rely on, and there are three ways to get one.

## Three mechanisms, in increasing order of strength

**Ask nicely.** "Reply as JSON." Works often, fails silently, and the failures cluster
where you least want them: long outputs, unusual inputs, the third retry at 2am.

**JSON mode.** Decoding is constrained to syntactically valid JSON. You get a parseable
document — not _your_ document: keys and types are still up to the model.

**Schema-constrained decoding.** You hand over a JSON Schema and the decoder is masked at
every step so only tokens that can still lead to a conforming document are sampled. That is
Ollama's `format` field with an object, and what the exercise sends.

The third is strictly better and still not a guarantee: it constrains the _decoder_, not
the values, and — as we are about to see — not necessarily in the way you believe.

## Designing a schema you will not regret

A few rules that pay for themselves:

- **Mark things required.** An optional field is one you will handle as `undefined`
  somewhere; `required: ["dates"]` is one line and removes a branch.
- **Prefer flat.** Each level of nesting is another place to put the right data in the
  wrong position.
- **Use `enum` wherever the value comes from a fixed set.** It turns a fuzzy classification
  into a choice among tokens, which is the most reliable thing these models do.
- **Add `maxLength`** to any field that will hold prose, and mean it.
- **Validate anyway.** Which brings us to the interesting part.

## The measured quirk: `think` and `format` are mutually exclusive

The M0 spike ran the same structured-output request five times — identical body, identical
schema, temperature 0 — and got **valid JSON three times out of five**. Twice the model
replied with three dates as plain text, `done_reason: "stop"`, no error. The obvious
conclusion was "constrained decoding here is about 60 % reliable, build a retry".

That conclusion was wrong, and finding out why is the point of this lesson. The follow-up
held everything constant and varied one flag, five runs each:

| `think` | valid JSON | avg latency (warm) |
| ------- | ---------- | ------------------ |
| `false` | 5 / 5      | 6.5 s              |
| `true`  | 0 / 5      | 5.5 s              |

Not 60 % reliable. **Deterministically broken in one configuration and deterministically
fine in the other.** With reasoning on, this model ignores the `format` schema entirely and
answers in prose. The original 3/5 averaged two different behaviours, and the averaging hid
the mechanism.

The narrow lesson: `OllamaProvider` now sends `think: false` on every request and refuses
to send `think: true` with `format` at all. Structured output went from a coin flip to a
feature, and got twice as fast doing it.

The general lesson is bigger: **the model is a component with quirks you discover by
measuring, not by reading.** No documentation said these two features interact, and the
behaviour was not an error — no exception, no warning, an ordinary `200 OK`. A single trial
would have shown "works" or "broken" and both would have been believed. Five trials showed
"flaky", which is the answer that makes you look for a variable.

## When validation fails anyway

Defence in depth, because "the decoder is constrained" is a claim about the decoder:

1. **Parse.** `JSON.parse` on the content. A failure here is a different bug from a schema
   failure and deserves a different message.
2. **Validate against the schema,** server-side, before any caller sees the value.
3. **Count the failure.** Every parse failure is a metric (`structured_output_retries_total`
   here, `tool_call_parse_failures_total` for tool calls). A failure you did not count is a
   failure you will not notice becoming common.
4. **Retry once**, appending the model's own bad answer and the validation error as a new
   user message. Once, not until it works: an unbounded repair loop against a component
   that takes forty seconds per call is a self-inflicted outage.
5. **Surface the error verbatim** if the retry also fails. "Invalid output" is not
   something anyone can act on.

The exercise tells you whether a retry happened. Watch for the case that succeeds only on
the retry: the feature works, it costs double, and the response alone never says so.

> **Where is this in the code?**
> `apps/api/src/model/structured.ts` — `validateStructuredOutput` and `buildRetryMessages`
> are pure and unit-tested; `runStructuredChat` is the orchestration around them. The
> validator is `apps/api/src/model/jsonSchema.ts` (hand written: these schemas are small
> and a dependency would need an ADR). The `think` rule is enforced twice on purpose, in
> `assertThinkFormatExclusive` (`apps/api/src/model/ollama.ts`) and again in the route. The
> measurement is `spike/ollama-think-vs-format.mjs` and decision 16 in
> `docs/07-open-decisions.md`.

> **What to measure**
>
> - **Validity rate over at least five runs.** One run cannot tell "works" from "works
>   sometimes", and that difference is the whole story above.
> - **Retry rate.** A rising one is the leading indicator that a prompt, a schema or a
>   model version has drifted.
> - **Latency with and without the flag you are testing.** `think:false` was both more
>   correct and twice as fast; when a trade-off vanishes, something structural is going on.
> - **Completion tokens.** The reasoning block was the entire cost difference — 240 tokens
>   versus a handful — not the JSON formatting.
> - **What the failures look like, not just how many.** "Not JSON" and "JSON without the
>   required key" have different fixes.
