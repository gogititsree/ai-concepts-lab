# ADR 0003 — Four deviations from the M11 harness design

- **Status:** accepted
- **Date:** 2026-09-19 (M11, harness worker and Module 6)
- **Deviates from:** `docs/01-architecture.md` → the stack table ("Code editor: CodeMirror
  6") and "Module 6 harness exercise: where the learner's loop runs";
  `docs/04-curriculum.md` → Module 6's exercise description

## 1. The editor is a `<textarea>`, not CodeMirror 6

`docs/01` names CodeMirror 6 as the stack's editor and Module 6 is the reason it is in
the list. **CodeMirror is not installed**, and `CLAUDE.md` says a dependency outside the
stack list needs the learner's agreement — which, read strictly, this one has, since the
doc names it. It was not added anyway, for one reason and one reason only: nobody was
available to ask, and a milestone is not the place to quietly add ~400 KB of dependency
tree to the bundle on an inference from a design document.

So `features/exercises/harness/CodeEditor.tsx` is a textarea with a monospace grid, a
synchronised line-number gutter, Tab/Shift+Tab indentation and an Escape hatch out of the
tab trap. What is lost is syntax highlighting, bracket matching and multi-cursor. What is
kept is everything the three checks depend on.

**This is the deviation to revisit first.** Swapping in CodeMirror is a contained change
— one component, one prop interface (`value`, `onChange`, `disabled`, `label`) — and it
is worth doing the moment the learner says yes. Nothing else in the exercise touches the
editor.

## 2. The worker's tool set is `calculator` and `get_current_time`, not three

`docs/01` and `docs/04` both list `lookup_glossary` as available in the worker,
implemented "via API". There is no API for it: `lookup_glossary` is a server-side tool
that runs an `ILIKE` over `lessons`, reachable only from inside `agentLoop.ts`. Exposing
it to the browser would mean adding a read-only `GET /model/glossary` endpoint whose only
consumer is one exercise, and whose existence duplicates part of the tool catalog outside
the loop that owns it.

Three reasons not to:

- **No check needs it.** All three scripted checks use `calculator`, and the optional
  real run is a single arithmetic question.
- **Tools are not free, and this is measured.** M10 found that attaching six catalog
  tools instead of one took the first model call from 227 to 1052 prompt tokens and from
  23 s to 71 s. On a five-minute budget with 9–25 s per warm call, the *fewest* tools
  that make the lesson land is the right number.
- **The lesson is about the loop, not the catalog.** Module 5 is where tool descriptions
  and the catalog are the subject.

The two tools that remain are implemented in `features/exercises/harness/workerTools.ts`
and run in the worker. The calculator there is a deliberately independent, smaller port of
`apps/api/src/model/tools/calculator.ts` — the duplication is the price of not making
`apps/web` depend on `apps/api`, and the part that is *not* duplicated is the mistake:
neither one calls `eval`.

## 3. `runAgent`'s options carry `toolDefs` as well as `maxIterations`

`docs/04` writes the contract as `runAgent(model, tools, userMessage, {maxIterations})`
and `model.chat(messages, toolDefs)`, which leaves the learner nowhere to get `toolDefs`
from. The alternatives were a global (invisible, and the sandbox shadows globals on
purpose) or hanging the definitions off the `tools` object the loop iterates (a booby
trap). So `options.toolDefs` exists, and `model.chat` falls back to the same definitions
when the second argument is omitted — a loop written exactly to the doc still works.

## 4. Two small API additions, both found by running the thing

Neither was reachable before M11, because the server loop owns both halves of its own
trace; the two writers can only disagree when one of them is a browser. Both are recorded
in `docs/spike-notes.md` under "M11 measurements" with the numbers that exposed them.

**`POST /model/chat` no longer counts tool calls when it is appending to someone else's
run.** It writes only `model_call` rows in that mode, and the browser reports the
`tool_call` row for the same call through `/model/runs/:id/steps`. The first real harness
run came back with `tool_call_count: 2` and exactly one `tool_call` step — a rollup
disagreeing with its own trace, which is the one thing a trace table must never do.
`tool_parse_failure_count` is unchanged and still server-side only, per ADR 0002: the
client is handed `args` already parsed and never sees the failure.

**`ModelChatRequestSchema` gained an optional `iteration`.** The route stamped
`iteration: index + 1` within one request, so every appended `model_call` row was
iteration 1 while the client's tool rows and `final` were numbered correctly, and the
trace viewer — which groups by iteration — drew a grouping that was simply false. The
field defaults to 1, so a single-turn call records exactly what it always did, and a
structured retry still advances within the caller's iteration.

## What is *not* a deviation, and is worth stating

The sandbox is not a security boundary, and the code says so at length in
`harnessCore.ts`. The worker is same-origin with the page: `Function('return this')()`
returns the real global, and a test asserts that it does, so the claim cannot go stale.
What the design buys is real but narrower than "sandbox" suggests — the page survives an
infinite loop because `terminate()` is available from outside, and server state is safe
because the worker holds no session and cannot fetch. The threat model is the learner's
own mistakes. If this app ever ran one person's code in another person's browser, none of
it would be enough and the loop would have to move to a separate origin or a container.
Module 6's third lesson makes that the teaching point rather than a footnote.

## Consequence

`docs/01-architecture.md` is out of date on the editor and on the worker's tool list, and
`docs/04-curriculum.md` on the tool list and the `runAgent` signature. They are left as
the design-time record; this ADR is the current truth, per the process in `CLAUDE.md`.
