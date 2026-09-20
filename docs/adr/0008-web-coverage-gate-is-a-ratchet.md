# ADR 0008 — The web coverage gate is a measured ratchet, not a target

- **Status:** accepted
- **Date:** 2026-09-20
- **Deviates from:** `docs/05-quality-and-ops.md` → Testing strategy, which said "90 % lines on
  `packages/nn-core` and `apps/api/src/{auth,model,progress}`; **no global gate elsewhere**"

## Context

`apps/web` had no coverage threshold, so nothing stopped it drifting. It measured
83.14 % statements / 83.93 branches / 78.80 functions — respectable, and invisible to CI.

The obvious move is to apply the same 90 % the other workspaces carry. That would have
failed immediately, and the two ways out of that are both bad: write filler tests until the
number goes green, or lower the gate to whatever passes and call it a standard. A gate that
fails on the next honest commit gets deleted, and a deleted gate protects nothing.

## Decision

Gate `apps/web` at **85 statements / 85 lines / 84 branches / 81 functions** — roughly one
point below the measured 85.58 / 85.58 / 84.97 / 82.10 after this milestone's tests.

The numbers mean "do not go backwards", not "this is good enough". They are a ratchet, to be
raised after a milestone that genuinely improves coverage, the way this one did (83.14 →
85.57). The config file says so at length so the next person does not read 85 as an
endorsement.

**Global, not per-directory**, unlike `apps/api`. The API gate is per-directory because
`docs/05` names three directories worth protecting. On the web side, reasonable coverage
varies by an order of magnitude and for good reasons: `features/ops` is at 99 % because it
is a table of numbers, `features/exercises/attention` is at 6 % because it draws arcs on a
canvas, and neither figure is a defect. A per-directory gate would be thirty numbers, most
of which nobody would ever revisit.

**`src/workers/harnessRunner.worker.ts` is excluded by name.** jsdom cannot execute a real
`Worker`, so its 88 statements of message plumbing are structurally untestable here, while
the 450-line core they delegate to is tested directly and sits at 97.87 %. Left in, the file
drags the global figure by about 1.05 points — which in practice means one untestable file
quietly buying slack for every testable one. Excluding it openly is more honest than a lower
global number that hides it.

## Consequences

- `docs/05-quality-and-ops.md`'s "no global gate elsewhere" is now wrong and has been
  corrected in place; this ADR is the record of why.
- Root `pnpm test:coverage` — the command CI's unit job already runs — now enforces two
  gates rather than one. No workflow change was needed.
- Raising the numbers is a deliberate act, not automatic. If a future milestone moves the
  measured figure up materially, move the gate with it in the same pull request.
