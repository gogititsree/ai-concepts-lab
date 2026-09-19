# M0 spike notes — Ollama tool calling and structured output

Date: 2026-09-17. Machine: Windows 11, Ollama 0.34.1 at `http://localhost:11434`, Node 24.16.0.

Script: `spike/ollama-spike.mjs` (plain ESM, no deps, global `fetch`). Raw responses saved to
`apps/api/test/fixtures/ollama/*.json`. A `_run-summary.json` in the same folder captures the
timing/outcome summary the script prints.

## Model substitution

Design docs (`docs/HANDOFF.md`, `docs/01-architecture.md`) name `gemma4:e4b`. That tag is **not**
installed on this machine and was **not** pulled, per instructions. The model actually available
via `ollama list` / `GET /api/tags` is:

```
gemma4:latest — 8.0B params, Q4_K_M quantization, context_length 131072, embedding_length 2560
capabilities: completion, vision, audio, tools, thinking
```

**All calls in this spike use `gemma4:latest`, not `gemma4:e4b`.** `OLLAMA_CHAT_MODEL` should
default to `gemma4:latest` when M9 builds the real provider, with an ADR or an update to
`01-architecture.md` / `HANDOFF.md` recording the substitution if the team wants to keep using
this machine's model long-term. Embedding model is `nomic-embed-text:latest` (137M, pulled fresh
for this spike, ~274 MB, `ollama pull nomic-embed-text` succeeded without issue).

## Latency per call (wall-clock, `stream:false`, cold-ish local CPU/GPU — see notes)

| Call | Latency | Notes |
|---|---|---|
| (a) chat-plain | 21.65 s | First call in the run; `total_duration` breakdown shows `load_duration` = 19.3 s of that (model loading into memory), `eval` itself only ~193 ms for 2 tokens. Subsequent calls are much faster once loaded. |
| (b) tool-call | 40.85 s | Includes `thinking` generation (228 eval tokens, ~36.1 s eval_duration) before emitting the tool call. |
| (c) tool-result-final | 23.08 s | `prompt_eval_cached_count: 106` — prior turns partially cached. |
| (d) structured-output (first attempt, in-script) | 7.14 s | Returned plain text, not JSON — see quirk below. |
| (d) structured-output (retries, ad-hoc curl) | 66.5 s, then 64.3 s | Successful JSON attempts had substantially higher `eval_count` (~240–307 tokens) because the `thinking` field is long; this is the dominant cost, not the JSON formatting itself. |
| (e) embed (3 inputs) | 1.21 s | Includes `load_duration` 1.10 s (first load of `nomic-embed-text`). |
| (f) tags | 17 ms | Trivial. |
| (reliability) 5× tool-call | 43.8 s, 12.6 s, 13.5 s, 34.7 s, 14.1 s | Wide variance (12–44 s) attributable to variable `thinking` length per run, not failure. Average ≈ 23.7 s. |

Takeaway: **latency is dominated by the `thinking` field** (gemma4:latest is a "thinking" model per
its capabilities) and by one-time model load (~19–37 s the first time a model is (re)loaded into
memory after being idle). `keep_alive` (per 01-architecture.md, default `10m`) will matter a lot
in the real provider to avoid repeated load costs. Per-call timeout of 90 s (as specified in
01-architecture.md) is workable but tight if a `thinking` response runs long, as seen in the
structured-output retries (64–66 s).

## Tool-call reliability: 5/5

Ran the exact "multiply 12345 by 6789, use the calculator tool" prompt 5 times with
`tools:[calculator]`. **All 5 runs returned a proper `message.tool_calls` array** — no
tool-call-as-text, no missing tool call. This is a strong result: native tool calling on
`gemma4:latest` looks reliable for a single, unambiguous tool with a simple string argument.

Each run's `tool_calls[0].function.arguments` was consistently:
```json
{ "expression": "12345 * 6789" }
```

## Tool-call argument shape: **object, not string**

`message.tool_calls[].function.arguments` arrived as a **parsed JSON object**
(`{"expression": "12345 * 6789"}`), not as a JSON-encoded string that needs a second
`JSON.parse`. This differs from some other providers/models where `arguments` is a string. The
`ModelProvider` mapping in `01-architecture.md` (`toolCalls[].args: unknown`, `rawArgs?: string`)
already accommodates either shape, but the `ollama.ts` adapter in M9 should **not** assume it
needs to `JSON.parse(arguments)` — it should handle both (check `typeof arguments === 'string'`
before parsing) since this could vary by model/version. For `gemma4:latest` specifically: it is
already an object.

Also note: Ollama's tool-call schema nests one level deeper than the provider-neutral shape in
01-architecture.md — the real field is `message.tool_calls[].function.{name,arguments}` plus an
`id` and an `index` inside `function`, e.g.:
```json
{
  "id": "call_s6jkagzm",
  "function": { "index": 0, "name": "calculator", "arguments": { "expression": "12345 * 6789" } }
}
```
This matches what 01-architecture.md already documents (`message.tool_calls[].function.{name,arguments}`).

## Tool-result round trip: works

Continuing the conversation with the assistant's tool-call message plus
`{ role: 'tool', content: '{"result": 83810205}', tool_name: 'calculator' }` produced a correct,
natural-language final answer: `"12345 multiplied by 6789 is 83,810,205."` No errors, no repeated
tool call, `done_reason: "stop"`.

## Structured output (`format` = JSON schema): reliable most of the time, **not 100%**

This was the most important quirk found in this spike. Using
`format: {type:'object', properties:{dates:{type:array, items:{type:string}}}, required:['dates']}`
against a paragraph with three dates:

- Ran 5 times total (1 inside the script + 4 ad-hoc `curl` retries with the identical body).
- **3 of 5 returned valid, schema-conforming JSON** (`{"dates": ["March 3, 1998", "July 14, 2005", "November 1, 2019"]}`).
- **2 of 5 returned plain natural-language text** (`"March 3, 1998\nJuly 14, 2005\nNovember 1, 2019"`) — `message.content` did **not** parse as JSON at all, despite `format` being set and `done_reason: "stop"` (no error, no truncation signal). Same exact request body both times.
- This is a **60% success rate on 5 trials** for this one schema/prompt — not the "works well enough" bar M0 is supposed to prove. It is inconsistent, not a schema-shape issue (same schema, same prompt, different outcome across identical requests).
- The saved fixture `structured-output.json` contains one of the **successful** runs (valid JSON matching the schema), since that's the useful case for `apps/api` provider tests to exercise the happy path against. The failure mode should be covered by a separate fake/negative-path test in M9, informed by this note.
- **Action for M9 / open-decisions.md:** the `ollama.ts` provider must treat `format`-constrained calls defensively — attempt `JSON.parse(message.content)`, and if it fails, apply the same "fenced JSON extraction" fallback logic already planned for tool-call parse failures (01-architecture.md's `tool_call_parse_failures_total{recovered}` pattern), or retry once. This should be called out in `07-open-decisions.md` alongside the tool-calling reliability note, since structured output reliability is the one that actually needs a fallback path based on this spike.

## `thinking` field: present, verbose, not requested

Every response involving any reasoning (tool-call, tool-result-final, and both structured-output
outcomes) included a `message.thinking` field with several sentences to a full paragraph of
chain-of-thought, even though it was never requested in the request body (no `think` option was
set). This is a quirk of `gemma4:latest`'s "thinking" capability:
- It is **not** part of the `ChatMessage` shape in `01-architecture.md`'s `ModelProvider` interface — the adapter should strip/ignore it (or optionally log it to `providerMeta`/`agent_run_steps.raw` for debugging, which the interface already supports).
- It substantially inflates `eval_count` / `eval_duration`, i.e., it is a major latency and (if this were a paid API) cost driver. `chat-plain.json` (no tool, no format) had no `thinking` field and only 2 eval tokens — the "reply with pong" case skipped thinking, so it appears to be prompted contextually rather than always-on.
- No `options.think` or similar flag was set for any call in this spike; default behavior was left as-is intentionally to observe raw defaults.

## Structured output vs tool calling — extra keys / shape notes

- `structured-output.json` responses had **no** `tool_calls` field at all (correctly absent —
  no tools were passed).
- Successful structured-output `message.content` was pretty-printed JSON with 4-space indentation
  (model-generated formatting, not something we imposed) — fine to `JSON.parse`, whitespace is
  irrelevant.
- No extra/unexpected top-level response keys beyond what 01-architecture.md documents:
  `model, created_at, message, done, done_reason, total_duration, load_duration,
  prompt_eval_count, prompt_eval_cached_count, prompt_eval_duration, eval_count, eval_duration`.
  Note `prompt_eval_cached_count` is not mentioned in 01-architecture.md's field-mapping list but
  is present in every response (0 when nothing cached, >0 on the multi-turn tool-result-final
  call) — worth adding to the provider's `providerMeta` capture.

## Embeddings

`POST /api/embed` with `model: nomic-embed-text`, `input: ["king","queen","apple"]` returned a
`{model, embeddings: number[][], total_duration, load_duration, prompt_eval_count}` shape —
`embeddings` (plural), 3 vectors of length 768 each (`nomic-embed-text`'s `embedding_length`). The
saved fixture truncates each vector to its first 8 numbers and adds `"_truncated": true` per the
task instructions; the real vectors are 768-dim. No errors, no quirks. `nomic-embed-text` pull and
health check both succeeded on first try.

## Exact request bodies that worked

**(a) Plain chat:**
```json
{
  "model": "gemma4:latest",
  "stream": false,
  "messages": [{"role":"user","content":"Reply with the single word: pong"}]
}
```

**(b) Tool call:**
```json
{
  "model": "gemma4:latest",
  "stream": false,
  "messages": [{"role":"user","content":"What is 12345 multiplied by 6789? Use the calculator tool."}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "calculator",
      "description": "Evaluate a basic arithmetic expression and return the numeric result.",
      "parameters": {
        "type": "object",
        "properties": { "expression": { "type": "string", "description": "The arithmetic expression to evaluate, e.g. \"12345 * 6789\"" } },
        "required": ["expression"]
      }
    }
  }]
}
```

**(c) Tool result → final answer** (append assistant message from (b), then):
```json
{
  "model": "gemma4:latest",
  "stream": false,
  "messages": [
    {"role":"user","content":"What is 12345 multiplied by 6789? Use the calculator tool."},
    {"role":"assistant","content":"","tool_calls":[{"id":"call_...","function":{"index":0,"name":"calculator","arguments":{"expression":"12345 * 6789"}}}]},
    {"role":"tool","content":"{\"result\": 83810205}","tool_name":"calculator"}
  ],
  "tools": [ /* same calculator tool def as (b) */ ]
}
```
Note: the tool definition had to be re-sent alongside the follow-up call; this matches how the
agent loop in 01-architecture.md keeps `tools` in every `provider.chat({messages, tools})` call.

**(d) Structured output:**
```json
{
  "model": "gemma4:latest",
  "stream": false,
  "messages": [{"role":"user","content":"<paragraph with three dates>"}],
  "format": {
    "type": "object",
    "properties": { "dates": { "type": "array", "items": { "type": "string" } } },
    "required": ["dates"]
  }
}
```
(Succeeded 3/5 times with this exact body; see reliability note above.)

**(e) Embed:**
```json
{ "model": "nomic-embed-text", "input": ["king", "queen", "apple"] }
```
POST to `/api/embed` (not `/api/embeddings`).

**(f) Tags:** `GET /api/tags`, no body.

## Bottom line for M9 / open-decisions.md

- **Tool calling: reliable (5/5).** Arguments arrive as a parsed object. Safe to build M9's
  `ollama.ts` assuming native tool calling works, with the fenced-JSON fallback kept as a
  defensive measure rather than the primary path.
- **Structured output (`format` = JSON schema): only 60% reliable (3/5) in this spike.** This is
  the one that needs the fallback/retry path called out in `07-open-decisions.md` before Module 4
  (M9) ships — either a retry-once-on-parse-failure strategy, a stricter system prompt
  ("Respond with JSON only, no other text"), or accepting a `structured_output_parse_failures`
  metric similar to the tool-call one. Worth an explicit open-decision entry since
  07-open-decisions.md currently only flags tool-calling reliability as the thing M0 verifies.
- **`thinking` field must be stripped/handled** by the provider adapter — not in the
  `ModelProvider` contract, adds real latency, present by default on this model even when
  not requested.
- Latency on this machine: expect **10–45 s per call** once the model is loaded (higher when a
  `thinking` block is long), and an extra **~20–40 s one-time load cost** after the model has been
  idle. `keep_alive` and generous timeouts (the 90 s in 01-architecture.md is reasonable but not
  overly generous) both matter.

## Follow-up: `think` vs `format` (2026-09-19)

Re-measured the structured-output flakiness from the original spike. Script: `spike/ollama-think-vs-format.mjs`
(5 runs per setting, `gemma4:latest`, temperature 0, identical schema and prompt).

| `think` | valid JSON | avg latency (warm) |
|---|---|---|
| `false` | 5 / 5 | 6.5 s |
| `true`  | 0 / 5 | 5.5 s |

With thinking enabled the model ignores the `format` JSON schema completely and replies in prose
("2024-03-15 2024-06-01 2024-11-20"), with `done_reason: "stop"` and no error. The two features are
mutually exclusive on this model. The original 3/5 result was thinking being on for some requests.

**Consequence for M9:** `OllamaProvider` sends `think: false` on every request. A lesson that wants to
display the model's reasoning must request it explicitly and must not also pass `format`.

## M9 measurements (2026-09-19, real provider, end to end)

Measured through `POST /api/v1/model/chat` with `MODEL_PROVIDER=ollama`, `gemma4:latest`,
temperature 0, against a real Postgres. Not a benchmark; these are the numbers a learner
will actually wait for on this machine.

| call | latency | prompt tokens | completion tokens |
|---|---|---|---|
| plain chat ("reply with: pong"), cold model load | 32.3 s | 16 | 2 |
| structured output, 3 dates, JSON schema, warm | 13.1 s | 64 | 40 |
| embeddings, 2 short inputs (`nomic-embed-text`, 768 dims) | < 1 s | — | — |

Structured output returned valid JSON on the first attempt with `retried: false`, which is
the `think:false` fix from the earlier follow-up holding through the real adapter.

Both calls persisted correctly for the observability work in M10/M14:

```
agent_runs:  prompt     | completed | ollama | gemma4:latest | iter 1 | 16/2  tok | 32314 ms
             structured | completed | ollama | gemma4:latest | iter 1 | 64/40 tok | 13080 ms
agent_run_steps: (0 model_call, 1 final) for each run, latency on the model_call step
```

**The cold-load penalty is the headline.** The first call after idle costs ~20 s more than a
warm one. `keep_alive: '10m'` covers a working session, but the first exercise run of the day
will feel broken without the elapsed-time counter the playground now shows.
