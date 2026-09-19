---
slug: describing-tools
title: Describing tools with JSON Schema
orderIndex: 2
estimatedMinutes: 14
---

# Describing tools with JSON Schema

A tool, as far as the model is concerned, is three strings and a schema:

```json
{
  "name": "calculator",
  "description": "Evaluate an arithmetic expression exactly. Use this for EVERY calculation, including ones that look easy - do not do arithmetic in your head. Supports + - * / % and ^ for powers, with parentheses. Example: {\"expression\": \"2500 * 1.07^8\"}. Returns the numeric result.",
  "parameters": {
    "type": "object",
    "properties": {
      "expression": {
        "type": "string",
        "description": "An arithmetic expression, e.g. \"2500 * 1.07^8\". Numbers and operators only."
      }
    },
    "required": ["expression"],
    "additionalProperties": false
  }
}
```

That is all it gets. It never sees the implementation, never learns what the tool did
last time, and has no way to ask a clarifying question about it. Which leads to the one
thing worth internalising from this lesson:

## The description is a prompt

It is not documentation. Nobody on your team reads it. It is text pasted into the model's
context, competing for attention with everything else in the window, and it is the single
biggest lever on whether an 8B model reaches for the right tool at the right moment.

Three rules, all of which the description above follows:

**Say what it does, in one clause.** "Evaluate an arithmetic expression exactly."

**Say when to use it.** This is the part people leave out, and it is the part that
changes behaviour. "Use this for EVERY calculation, including ones that look easy." A
small model's default is to answer arithmetic from memory, confidently and wrongly. The
instruction that stops it is in the tool description, not only in the system prompt,
because the description is right next to the thing being described.

**Show one example argument.** `{"expression": "2500 * 1.07^8"}`. One concrete example is
worth more than a paragraph of prose about the format, for the same reason few-shot
prompting works at all.

Compare: a tool described as `"Performs computation."` will be called sometimes, with
arguments in whatever shape the model guesses. The information content of that string is
approximately zero, and the model is not being stupid when it ignores it.

## What the schema is for, and what it is not for

The `parameters` object is JSON Schema, and it does two jobs that are easy to conflate.

For the **model**, it is a hint — a very good one. Providers feed it to constrained
decoding, so the model is nudged hard towards emitting a conforming object. `enum` is the
most reliable construct there is: `"timezone": {"enum": ["UTC", "Europe/London", ...]}`
turns an open-ended question into a choice among tokens, which is the thing these models
are best at. An open `"timezone": {"type": "string"}` field produces `"EST"`, `"GMT+1"`
and `"Pacific Time"`, none of which `Intl` accepts.

For the **server**, it is a contract that must be enforced again. Constrained decoding
reduces malformed arguments; it does not eliminate them, and it says nothing at all about
whether the values make sense. This app validates every tool call against the schema
before executing anything, and a validation failure is not a crash — it becomes a
`tool_result` with `is_error` set and the specific complaint inside it, appended to the
conversation. The model reads its own mistake on the next turn and usually fixes it. You
will see that recovery in the trace.

A few smaller decisions worth copying:

- **`required` matters.** An optional field is one you will handle as `undefined`
  somewhere. Mark what you need.
- **`additionalProperties: false`, and mean it.** In this app the Zod schema is `.strict()`
  too, so the server's behaviour matches what the model was told. A schema that says one
  thing while the server quietly does another is the drift that makes tool bugs
  unfindable.
- **Flat beats nested.** Every level of nesting is another place to put the right value in
  the wrong position.
- **Describe every property.** The property descriptions are also prompt text.

## Mock tools: schemas without an implementation

The exercise lets you invent a tool: a name, a description, a JSON Schema and a canned
response. The server stores those four pieces of data and "executes" the tool by looking
the answer up in a table. Nothing you write is ever run as code — this app has no
server-side `eval`, deliberately and permanently.

That turns out to be enough for the whole lesson. What you are learning here is how a
description and a schema steer the model, and how the result travels back as a `tool`
message. None of that needs the tool to compute anything. A mock `get_order_status` that
always answers `{"status": "shipped"}` produces an identical trace to one backed by a real
warehouse, and you can iterate on the description in seconds.

It also gives you the cheapest possible experiment: write a deliberately vague
description, watch the agent fail to call it, then rewrite the description and watch it
succeed. That single before-and-after is the most useful thing in this module.

> **Where is this in the code?**
> `apps/api/src/model/tools/catalog.ts` holds the five real tools; every description there
> follows the three rules above, and there is a unit test that fails if one of them gets
> shorter than sixty characters or stops saying when to call it. The JSON Schema the model
> sees is _derived_ from the Zod schema by
> `apps/api/src/model/tools/zodJsonSchema.ts` — one source, two consumers, so the
> validator and the prompt cannot drift apart. Mock tools are
> `apps/api/src/model/tools/mock.ts`, and the "never execute learner code" rule is the
> reason that file is a lookup table rather than a sandbox.
