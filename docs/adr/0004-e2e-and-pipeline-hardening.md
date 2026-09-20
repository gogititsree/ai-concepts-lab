# ADR 0004 — Five deviations in the M12 E2E and pipeline

- **Status:** accepted
- **Date:** 2026-09-19 (M12, test completeness and pipeline hardening)
- **Deviates from:** `docs/05-quality-and-ops.md` → "Unit tests" (the coverage gate),
  "The one end-to-end test" (steps 5 and 6), "CI/CD → `ci.yml`" (the job list), and
  "Branch protection on `main`"

## 1. The 90 % gate is measured over the unit **and** integration suites

`docs/05` puts the sentence "Coverage gate: 90 % lines on `nn-core` and
`apps/api/src/{auth,model,progress}`" under the **Unit tests** heading. Taken literally
that is unreachable, and not because the code is untested.

Measured with the unit suite alone (`pnpm --filter api test:coverage`):

| directory             | lines  |
| --------------------- | ------ |
| `apps/api/src/auth`    | 33.7 % |
| `apps/api/src/model`   | 61.4 % |
| `apps/api/src/progress`| 44.6 % |

The shortfall is concentrated in four files — `auth/routes.ts`, `auth/mfaRoutes.ts`,
`model/routes.ts`, `progress/routes.ts` — which are Fastify plugins. The *same document*
says how those are tested: "Auth end-to-end at HTTP level … requests via `app.inject()`",
in the integration suite. There is no honest unit test for `POST /auth/mfa/confirm` that
does not amount to reimplementing Fastify.

So the gate is enforced across both suites instead. `apps/api/vitest.coverage.config.ts`
includes `test/**/*.test.ts` (unit *and* `test/integration/`), instruments only the three
gated directories and sets per-directory `lines: 90` thresholds. Measured that way:

| directory              | lines  |
| ---------------------- | ------ |
| `apps/api/src/auth`     | 92.97 % |
| `apps/api/src/model`    | 94.75 % (`src/model/tools` 90.17 %) |
| `apps/api/src/progress` | 97.24 % |

Rejected alternatives: **lowering the number** (the gate then measures nothing — a 35 %
threshold is satisfied by deleting tests), and **mock-shaped route unit tests** (a second
copy of every auth test, asserting against a stubbed Fastify instead of against the
behaviour, which is how a suite gets slower *and* less trustworthy at the same time).

The cost, and it is a real one: the gate needs Postgres, so it runs in CI's `integration`
job rather than in `unit`. `packages/nn-core`'s 90 % gate is unaffected and stays in the
unit job where `docs/05` puts it. There is still no global gate anywhere.

## 2. The E2E asserts Module 1 progress, not a "complete" progress ring

`docs/05` step 5 ends "dashboard shows Module 1 progress ring complete". The ring's
fraction counts all three lessons, both exercise tasks and the quiz. Completing it would
mean the E2E also reads lessons 2 and 3 and runs **twenty epochs of XOR** (the
`try-xor` task) — about 2 s of animation plus three more page loads, to assert a number
that `v_user_module_progress` already has an integration test for.

The test therefore asserts what it actually earned: the Module 1 card reads
`1/3 lessons · quiz passed`. That is a real statement about the progress rollup — it
proves the lesson write, the quiz attempt and the aggregation view all landed — without
padding the browser test with work the integration suite covers better.

## 3. The E2E chooses the fake provider's scenario through the system prompt

Step 6 asks for "model_call → tool_call → tool_result → final". `FakeProvider`'s default
scenario for Module 5's shipped system prompt is `plain-answer`, which produces
`model_call → final` — no tool. Rather than add a test-only query parameter or a seeded
fixture exercise, the test types `scenario: tool-call-once` into the system-prompt box.

This is not a hack bolted on for the test: `apps/api/src/model/fake.ts` documents the
system-prompt marker as *the* way "the Playwright E2E and manual demos pick [a scenario]
without a bespoke API", and `selectScenario` has a unit test for it. Nothing test-shaped
is added to the production path.

## 4. `ci.yml` grows a `security` job, and `build-image` waits for `e2e`

`docs/05` sketches five jobs. Two changes:

- **A `security` job** (`pnpm audit --audit-level=high` plus a gitleaks history scan),
  because M12's task list asks for the audit and the sketch had nowhere to put it. It
  does not gate anything else, so a registry outage cannot block a merge; the audit level
  means low and moderate advisories are logged, not enforced.
- **`build-image` needs `e2e`**, where the sketch had `needs: [lint, unit, integration]`.
  Publishing an image whose end-to-end journey was never run, and then letting
  `deploy.yml` pick it up on `main`, defeats the point of having the E2E at all. The cost
  is ~2 minutes of serialisation on the path to GHCR.

## 5. Branch protection is documented, not configured

`docs/05` says "Branch protection on `main`: PR required, `ci` checks required, no
force-push." There is no git remote and no GitHub repository yet, so there is nothing to
configure and no file in the repo that can express it. The exact steps — including the
`gh` CLI commands and the four required check names — are written down in
`docs/github-setup.md`, to be run once the repository exists. `CONTRIBUTING.md` records
the branch-per-milestone workflow the protection is there to enforce.

## Smaller notes (not deviations, but worth finding later)

- **The E2E database is `lab_e2e`**, dropped and recreated by `scripts/e2e-db.mjs` before
  every run. Same idea as the per-file throwaway database the integration harness already
  uses, one level up.
- **The test never sleeps for a TOTP step.** `/auth/mfa/confirm` stores the step it
  consumed in `mfa_totp.last_used_step`, so a second code at the same step is correctly
  rejected as a replay. Instead of waiting up to 30 s for the clock, the login step
  computes the code for `confirmStep + 1`, which is above `last_used_step` and inside the
  server's ±1 window for the next 60–90 s.
- **The E2E runs with `COOKIE_SECURE=false`.** `NODE_ENV=production` is required for
  Fastify to serve the SPA, and it defaults `COOKIE_SECURE` to true, which silently drops
  the session cookie over plain `http://127.0.0.1`. This is configuration, not a code
  change — but it is the single most confusing failure the suite can produce, so it is
  written down here as well as in `playwright.config.ts`.

## Addendum — the image could not build, and nothing had noticed

Running `docker build` as part of this milestone's verification failed:

```
Could not resolve "../../../../../../content/modules/03-how-llms-work/corpus.txt?raw"
  from "src/features/exercises/tokenizer/bundledCorpus.ts"
```

`docker/Dockerfile` copies `packages` and `apps` into the build stage but never `content`.
That was correct through M7, when `content/` was only seed data read at runtime from a
working copy. **M8 changed its status without changing the Dockerfile**: the tokenizer
bundles `corpus.txt` and the embeddings fallback bundles `embeddings-precomputed.json`,
both through Vite `?raw` imports, which makes `content/` a *build input*.

Local builds never caught it because `content/` is simply there on disk. Only the image,
which copies an explicit subset, is strict enough to notice.

Fixed by copying `content` in the build stage, and again into the runtime stage so
`pnpm db:seed` can run inside the container rather than only from a laptop pointed at the
production database.

**The guard already existed and had never executed.** CI's `build-image` job builds on
every pull request, so this would have failed the first PR after M8. It did not, because
the repository has no remote and no workflow has ever run. That is the honest cost of
deferring `docs/github-setup.md`, and it is worth remembering when judging how much
assurance a green local suite actually provides.
