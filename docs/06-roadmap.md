# 06 — Build roadmap

**Status: all sixteen milestones are complete (M0–M15), merged on `main`.** This document
is now a record as much as a plan. Each milestone keeps its original brief — the goal, the
tasks, the acceptance criteria — and gains a **Done** paragraph saying what actually
happened and where reality diverged. Read the Done paragraphs first if you are picking
this up; the condensed as-built picture is in `docs/HANDOFF.md`.

One divergence is shared by every milestone and is stated once here rather than sixteen
times: **there is no git remote, no GitHub repository and no Render service.** Every
milestone's "CI green" criterion was met by running the gate locally — `pnpm verify`,
`pnpm test:e2e`, `pnpm test:coverage:gate`, `docker build`. `.github/workflows/*.yml` and
`render.yaml` are written, reviewed and have **never executed**; `docs/github-setup.md` is
the one-time set-up. Two separate incidents now have "the guard existed and never ran" in
their root cause (ADR 0004's addendum, and
`docs/postmortems/2026-09-20-rename-final-output.md`), which makes creating the repository
the highest-value single action left in this project.

Sixteen milestones, M0–M15. Each is written to be handed to a coding session on its own: it states the goal, what exists before it starts, the tasks, the acceptance criteria, and the SDLC skill it teaches. Every milestone ends with green CI on `main`. Do them in order; the only safe reorder is swapping M7 and M8.

Conventions for every milestone:
- Branch `mNN-<slug>`, PR into `main`, squash-merge.
- Add/extend tests before marking done; CI must pass.
- Update `docs/` when a decision changes; add an ADR file `docs/adr/NNNN-<title>.md` for any deviation from these docs.
- Ask the learner (the user) before adding a dependency not listed in 01-architecture.md.

---

## M0 — Environment and model spike  (½ day)
**Goal:** prove the risky assumption before building on it: Gemma 4 via Ollama does native tool calling and JSON-schema output well enough.
**Tasks:** install Node 22 LTS, pnpm 9, Docker Desktop, Ollama; `ollama pull gemma4:e4b` and `nomic-embed-text`; write `spike/ollama-tools.http` (or a curl script) that (a) sends a chat with a `calculator` tool and a prompt that needs it, (b) sends a request with `format` = a JSON schema, (c) sends a tool result back and gets a final answer, (d) calls `/api/embed`. Record raw responses into `apps/api/test/fixtures/ollama/*.json` (used later by provider unit tests). Note latency on this machine.
**Accept:** four fixture files committed; a short `docs/spike-notes.md` with latencies and any quirks (e.g. tool args arriving as strings). If tool calling is unreliable, escalate to the open decision in 07-open-decisions.md before M9.
**Teaches:** de-risking; reading an API by hand.

**Done.** `gemma4:e4b` is not installed on this machine and was not pulled; everything
uses **`gemma4:latest`** (8B, Q4_K_M, 131k context, a *thinking* model), plus
`nomic-embed-text:latest` for embeddings. Tool calling was 5/5 reliable, so the
prompt-based fallback in `docs/07-open-decisions.md` was never needed; structured output
was **not** 100 % and needs a retry. The dominant latency cost turned out to be the
model's unrequested `thinking` field, which is why the provider sends `think: false`.
Four fixtures plus `docs/spike-notes.md`, which grew measurements at M9, M10 and M11.

## M1 — Hello world, end to end, deployed  (1–2 days)
**Goal:** the skeleton monorepo exists, runs locally, has CI, and a "hello" version is live on Render.
**Tasks:** `pnpm-workspace.yaml`; `apps/api` (Fastify, `GET /api/v1/health` → `{status:'ok'}`, pino, Zod config with `PORT`, `NODE_ENV`); `apps/web` (Vite React TS, one page fetching `/api/v1/health` via the Vite dev proxy); `packages/shared` (health response schema); `packages/nn-core` (empty with one exported `add` and one test so the pipeline is real); root ESLint/Prettier/tsconfig.base; `docker/Dockerfile` multi-stage producing one image where the API serves `apps/web/dist`; `docker/docker-compose.yml` with Postgres (unused yet); `.github/workflows/ci.yml` (lint, unit, build-image → GHCR); `deploy.yml` (Render deploy hook + health poll); Render web service created from the GHCR image; README with setup steps.
**Accept:** `pnpm dev` serves web+api locally; `docker build` + `docker run` serves both on one port; CI green; `https://<app>.onrender.com/api/v1/health` returns ok; `deploy.yml` succeeded once.
**Teaches:** monorepo, Docker multi-stage, CI, free-tier deploy, secrets (`RENDER_DEPLOY_HOOK_URL`).

**Done, except the deploy.** The monorepo, the multi-stage Docker image, `ci.yml` and
`deploy.yml` all exist and were verified locally. The Render service does not, so
`https://<app>.onrender.com/api/v1/health` has never answered and `deploy.yml` has never
succeeded once.

## M2 — `nn-core`: the math, with tests  (2–3 days)
**Goal:** all from-scratch ML code for modules 1–3, framework-free, fully tested.
**Tasks:** `perceptron.ts` (predict, trainStep, trainEpoch, accuracy); `mlp.ts` (configurable layers, sigmoid/tanh, MSE + BCE loss, forward with cached activations, backward returning grads, `step(lr)`, seeded PRNG init); `gradcheck.ts` (central finite differences, relative error); `datasets.ts` (blobs, diagonal, xor, circle, moons, spiral, seeded); `bpe.ts` (train(corpus, numMerges), encode, decode, merges table); `attention.ts` (scaledDotProductAttention(Q,K,V, {scale, temperature}) → weights + output, softmax); `pca.ts` (mean-centre, covariance, top-2 components by power iteration, project); `linalg.ts` helpers. Tests per 05-quality-and-ops.md. Vitest with coverage; `nn-core` README documenting the API with the numeric worked example that Lesson 2.2 will reuse.
**Accept:** gradient-check test passes with rel. error < 1e-6; XOR converges; BPE round-trips; attention rows sum to 1; coverage ≥ 90 %.
**Teaches:** programming fundamentals, numerical testing, package design.

**Done, as written.** Gradient check below 1e-6, XOR converges, BPE round-trips,
attention rows sum to 1, coverage above 90 %. The one milestone with no deviations at
all, which is what happens when the specification is mathematics.

## M3 — Modules 1 & 2 in the browser (no DB, no auth)  (3–4 days)
**Goal:** the perceptron and MLP exercises and lessons are usable, with content loaded from static JSON/MD for now.
**Tasks:** React Router routes for `/modules`, `/modules/:slug`, lessons, exercise; Markdown+KaTeX lesson renderer; `useAnimationLoop`; Zustand stores; `PerceptronCanvas`, `NetworkGraph`, `BoundaryHeatmap`, `LossChart`; exercise task auto-checks (client-side) for modules 1–2; content files for modules 1–2 written in `content/` (lessons, exercise config, quiz JSON) and imported statically by the web app **temporarily** (a `content-static` loader that M6 replaces); quiz page with client-side grading **temporarily**.
**Accept:** you can read all lessons, complete both exercises' tasks, take both quizzes; Testing Library tests for auto-checks; visual check at 375 px width.
**Teaches:** frontend architecture, Canvas vs SVG, rendering loops, component boundaries.

**Done, as written.** The temporary static content loaders were deleted in M7 as
planned.

## M4 — Database, migrations, seed  (2 days)
**Goal:** Postgres schema from 02-schema.md exists via Drizzle migrations; content seeds from `content/`.
**Tasks:** Drizzle schema for **all** tables/enums/view (yes, all, so later milestones only write code); `drizzle-kit generate` → commit SQL; `migrate.ts`; `seed.ts` that validates content with `packages/shared` schemas and upserts with uuid-v5 ids (idempotent); integration-test harness (`test/setup.ts` creating a fresh schema per file); `pnpm db:migrate|seed|studio` scripts; ERD exported to `docs/erd.md` via `drizzle-kit`/dbml.
**Accept:** `docker compose up -d postgres && pnpm db:migrate && pnpm db:seed` twice → same row counts; integration test "migrate+seed idempotent" passes in CI with the Postgres service; `EXPLAIN ANALYZE` of `v_user_module_progress` recorded in a comment.
**Teaches:** schema design in practice, migrations, seeding, test databases.

**Done**, with one harness deviation worth knowing. Integration tests get a **throwaway
database per test file** (`CREATE DATABASE … TEMPLATE template0`, ~100–200 ms), not a
schema per file: a schema per file does not survive drizzle-kit, whose generated DDL
qualifies enums and the view as `"public".…`, and rewriting that SQL at test time would
mean the tests no longer exercise the migration that ships. Reasoning is in
`apps/api/test/setup/db.ts`.

## M5 — Auth: register, login, sessions  (2–3 days)
**Goal:** real accounts and sessions per 03-auth-mfa.md, without MFA yet.
**Tasks:** `password.ts` (argon2id), `session.ts` (token mint/hash/lookup/touch/revoke), cookie plugin, CSRF header + Origin check, rate limits, lockout, `auth_events`, routes `register/login/logout/me/password/sessions`, `requireAuth` guard; frontend: login/register pages, `RequireAuth`, `['me']` query, settings page listing sessions; `X-Requested-With` added by the fetch client.
**Accept:** integration tests listed in 05-quality-and-ops.md (auth without MFA parts) pass; cookie flags asserted; lockout test with fake timers; `pnpm audit` clean.
**Teaches:** authentication, sessions, threat modelling, rate limiting.

**Done, as written.**

## M6 — MFA (TOTP + backup codes)  (2 days)
**Goal:** complete the flows in 03-auth-mfa.md.
**Tasks:** AES-GCM helper with `MFA_ENCRYPTION_KEY`; `totp.ts` (otplib, window, replay via `last_used_step`); `backupCodes.ts`; routes `mfa/enroll|confirm|verify|disable|backup-codes/regenerate`; pending-session semantics in the guard; frontend: `/login/mfa`, enrollment wizard (QR → code → backup codes download), disable flow, "remaining backup codes" nag.
**Accept:** RFC 6238 vector test; replay and window tests; full HTTP-level auth+MFA integration test; manual test with a real authenticator app documented in README.
**Teaches:** MFA, crypto-at-rest, step-up auth.

**Done, as written.** One detail later milestones depend on: `/auth/mfa/confirm` records
the consumed step in `mfa_totp.last_used_step`, so tests compute a code for
`confirmStep + 1` instead of sleeping 30 s for the clock.

## M7 — Content, progress and quizzes from the API  (2–3 days)
**Goal:** replace M3's static loaders; progress is persisted; quizzes graded server-side.
**Tasks:** content routes (with the "never leak `correct`" test); progress routes; `completion_rule` evaluation; quiz attempt grading per question kind; `GET /progress` from the view; frontend switches to TanStack Query; dashboard with progress rings; exercise state debounce-save; module gating UX (none: all modules open, but progress shown).
**Accept:** integration tests for content/progress/quiz; the M3 flows work end-to-end against the DB; delete the static loaders.
**Teaches:** REST design, server-side validation, query/mutation patterns.

**Done**, and it produced **ADR 0001**. The `v_user_module_progress` view as designed
counted lessons wrong — a join fan-out multiplied the counts — and was rewritten with
lateral subqueries in migration `0001_fix_progress_view_fan_out.sql`.

## M8 — Module 3 (tokenizer, embeddings, attention)  (3 days)
**Goal:** the LLM-internals module is complete, model-optional.
**Tasks:** `TokenChips`, `MergeTable`, `EmbeddingScatter`, `AttentionHeatmap`, `AttentionArcs`; `POST /api/v1/model/embed` route (provider stub returns 503 until M9; UI uses fallback); script `pnpm content:embeddings` that generates `embeddings-precomputed.json` with Ollama; lessons 3.1–3.4; quiz; tasks/auto-checks.
**Accept:** all three tabs work with `MODEL_PROVIDER=none`; nn-core tests already cover the math; a11y pass on the heatmap (values readable on hover/focus).
**Teaches:** data-viz components, graceful degradation.

**Done**, and it quietly changed the status of `content/` from *runtime seed data* to a
**build input**: the tokenizer corpus and the embeddings fallback are Vite `?raw`
imports. The Dockerfile was not updated to match and nothing noticed, because local
builds have `content/` on disk. Found by hand in M12 — ADR 0004's addendum.

## M9 — `ModelProvider` + Module 4  (3 days)
**Goal:** the LLM seam exists with Ollama and Fake implementations; prompting/structured-output module works.
**Tasks:** `provider.ts` interface (from 01-architecture.md); `ollama.ts` (mapping, timeouts, fenced-JSON tool-call recovery, embed, health) tested with M0 fixtures; `fake.ts` with scenario table; `none`; `POST /model/chat` logging a run of kind prompt/structured; `GET /model/health`; the UI banner; Module 4 lessons, playground, task checks, JSON-schema editor with Zod validation; `agent_runs` written for every call.
**Accept:** provider unit tests; integration tests with fake; manual run against Gemma recorded in `docs/spike-notes.md` (latency, tokens); `MODEL_PROVIDER=none` on Render shows the banner.
**Teaches:** interface-driven design, adapters, test doubles.

**Done.** The model tag is `gemma4:latest` throughout (M0), `think: false` is sent on
every request, and combining `think` with `format` is refused outright. Real-provider
latency and token measurements are recorded in `docs/spike-notes.md`.

## M10 — Agent loop + Module 5  (3–4 days)
**Goal:** server-side agent loop with tool catalog, mock tools, SSE streaming, trace viewer.
**Tasks:** `tools/` (catalog with Zod arg schemas, `lookup_glossary` querying lessons), mock-tool executor; `agentLoop.ts` per 01-architecture.md with guardrails and step persistence; `POST /model/runs`, SSE `events`, `cancel`, list/get; concurrency semaphore (1 run at a time per instance); `AgentTrace`, `ToolSchemaBuilder`, `/runs`, `/runs/:id`; Module 5 lessons, tasks, quiz.
**Accept:** loop scenarios (happy, unknown tool, invalid args, max-iterations, timeout, cancel) pass with fake; a real run against Gemma completes the `compound-interest` task; SSE reconnect resumes from `Last-Event-ID`.
**Teaches:** async control flow, streaming, persistence of partial state, guardrails.

**Done**, with **ADR 0002** (three deviations): a sixth catalog tool `flaky_service` for
the failure-path lesson, `parse_ok` counting only provider-side parse failures, and
`GET /model/tools` added to the route table. Measured against the real model: 13/13
correct decisions to call a tool, inference is over 99.9 % of a run's wall clock, and
attaching all six tools instead of one costs 4.6× the prompt and 3× the latency.

## M11 — Harness exercise + Module 6  (3 days)
**Goal:** the learner can implement the loop in the browser and pass scripted checks.
**Tasks:** `harnessRunner.worker.ts` (sandboxed execution of learner code via `new Function` inside a Worker with a restricted global, message protocol for `model.chat`/tools/steps/logs, timeout); `POST /model/runs/:id/steps` (validated, capped); CodeMirror editor with starter code; scripted fake inside the worker; the three checks; Module 6 lessons including the "real harnesses" lesson; quiz.
**Accept:** reference solution stored in `apps/web/src/features/exercises/harness/reference.ts` passes all checks in a Vitest test that drives the worker protocol; a broken solution fails the right check; real-model run shows in `/runs/:id`.
**Teaches:** sandboxing, worker messaging, writing a spec that checks itself.

**Done**, with **ADR 0003** (four deviations): a `<textarea>` rather than CodeMirror 6 in
the harness editor, two worker tools rather than three, `toolDefs` carried in
`runAgent`'s options, and two small API additions found by running the thing.

## M12 — Test completeness and pipeline hardening  (2 days)
**Goal:** the full test pyramid and CI from 05-quality-and-ops.md.
**Tasks:** the Playwright E2E; coverage gates; `e2e` CI job; branch protection; dependabot config; `pnpm audit` in CI (fail on high); build provenance (`GIT_SHA` build arg surfaced in `/health`).
**Accept:** CI runs lint/unit/integration/e2e/build on PRs; E2E green in CI; `main` protected.
**Teaches:** test strategy, CI as gatekeeper.

**Done**, with **ADR 0004** (five deviations): the 90 % coverage gate is measured across
the unit *and* integration suites, because Fastify route plugins have no honest unit
test; the E2E asserts Module 1 progress rather than a completed ring; the E2E picks the
fake provider's scenario through the system prompt; `ci.yml` grew a `security` job and
`build-image` now waits for `e2e`; and branch protection is documented rather than
configured, because there is no repository to configure it on. The addendum is the part
that matters: `docker build` failed because the Dockerfile never copied `content/` — a
guard that had existed since M1 and had never once executed.

## M13 — Production hardening on Render + Neon  (2 days)
**Goal:** the deployed app is real: Neon Postgres, migrations as pre-deploy step, secrets, security headers.
**Tasks:** Neon project + `DATABASE_URL` (pooled); Render pre-deploy command; `@fastify/helmet` CSP tuned for the SPA; HTTPS-only cookies; `APP_ORIGIN`; `render.yaml`; post-deploy smoke in `deploy.yml`; seed in production (one-off job); session/run cleanup as a Render cron job or GitHub Actions schedule calling an authenticated maintenance endpoint; backups: Neon point-in-time restore noted in runbook.
**Accept:** register + MFA works on the public URL; modules 1–3 fully usable; 4–6 show the banner; `deploy.yml` smoke passes; secrets nowhere in git (`gitleaks` in CI).
**Teaches:** DevOps, environments, secrets, security headers.

**Done as code, not as a deployment**, with **ADR 0005** (seven decisions):
`MAINTENANCE_TOKEN` optional and failing closed; `style-src` keeping `'unsafe-inline'`
while `script-src` does not; a looser CSP served with the harness worker script;
`GIT_SHA` no longer defaulting to `dev` in the image; a post-deploy smoke check that
cannot fetch six modules and cannot check a run page; a pool of 3 with prepared
statements off for a pooled endpoint; and a written account of how the CSP was proved and
what is still unproven. Neon and Render were never provisioned, so "register + MFA works
on the public URL" is unverified.

## M14 — Observability, SLOs, alerting, runbooks  (3 days)
**Goal:** everything in the SRE section exists.
**Tasks:** prom-client metrics per table; `/metrics` with token; `/ops/sli` + `/ops` page; compose `observability` profile with Prometheus/Grafana/Loki and a provisioned dashboard; Grafana alert rules; UptimeRobot on `/health`; `uptime.yml` scheduled check creating GitHub issues; `docs/slo.md`; the seven runbooks; log redaction tests.
**Accept:** dashboard shows a real run's latency/tokens/iterations; killing Ollama flips `model_provider_up` and fires the Grafana alert; `uptime.yml` opens an issue when pointed at a dead URL (test it once).
**Teaches:** SRE fundamentals.

**Done**, with **ADR 0006** (five deviations): `/metrics` served at the root *and* under
`/api/v1`; `/metrics` failing closed with 503 when `METRICS_TOKEN` is unset; `/ops/sli`
accepting the `METRICS_TOKEN` bearer so a cookie-less workflow can read it;
`db_query_duration_seconds` covering only instrumented queries; and two accepted data-viz
validator findings on the `/ops` palette. Also recorded there: `/health` never actually
returns `degraded`. M15 found a sixth gap that ADR 0006 does **not** cover — the
per-model-call structured logging `docs/05` specifies was never implemented, so Loki
holds nothing but HTTP access lines and contributed nothing during a real incident.

## M15 — Break it on purpose: the postmortem exercise  (1 day + write-up)
**Goal:** run the primary scenario (bad migration) and the alternate (Ollama down mid-run) from 05-quality-and-ops.md; write two blameless postmortems; turn action items into issues; implement at least one (the post-deploy smoke test for `/runs/:id`, and expand/contract documentation in the migration runbook).
**Accept:** `docs/postmortems/2026-xx-xx-rename-final-output.md` and `...-ollama-down.md` complete per template; action items tracked; the incident is no longer reproducible after the fixes.
**Teaches:** incident response, blameless culture, feedback into the curriculum.

**Done.** Both scenarios were staged against the real stack — Postgres in Docker, the
built `dist` in production mode, the observability profile, real Ollama — and both
postmortems are written from `docs/postmortems/TEMPLATE.md`:
`2026-09-20-rename-final-output.md` and `2026-09-20-ollama-down-mid-run.md`.

What diverged from the plan, which is the interesting part:

- **The primary scenario as `docs/05` writes it cannot be shipped from this codebase.**
  `tsc` rejects the one-step rename in ten seconds at three call sites, because every
  reader and writer of that column goes through a single typed drizzle declaration.
  Reproducing the incident required a variant that keeps the compiler happy — declaring
  both column names at once — which is, if anything, *more* realistic: it is the shape of
  a change that passes review.
- **`docs/05` predicted that creating runs would still work. It did not.** Drizzle's
  `INSERT … RETURNING` enumerates every declared column, so one missing column broke the
  write path, the list path and the detail path together. The blast radius was the whole
  `agent_runs` table, not one route.
- **`/health` reporting `ok` throughout was confirmed exactly as predicted**, and
  `deploy.yml`'s post-deploy smoke check was *verified* to pass against the broken
  deployment.
- **One item on `docs/05`'s expected list for the Ollama scenario did not happen**: the
  "model unavailable" banner never flipped, because `useModelHealth` has no poll interval
  and `refetchOnWindowFocus` is off globally. `docs/05` says anything that does not happen
  is a bug found by the exercise. It is, and it is action item 1 of that postmortem.
- **Action items were implemented, not only filed**: a schema-drift check
  (`apps/api/src/db/schemaCheck.ts`) surfaced as `checks.schema` on `/health` and asserted
  by `deploy.yml`, with unit and integration regression tests; plus corrections to four
  runbooks and to `docs/slo.md`. The incident was then re-staged and the new check failed
  the deploy, as designed.
- **The incident migrations were removed from the repository afterwards** and the lab
  database recreated from scratch, because the fault was manufactured for a teaching
  exercise. In production that would be impossible — migrations are forward-only — and
  the postmortem says so.

---

## After M15 — open action items, roughly in order of value

These come from the two M15 postmortems and are the only items in this document with a
claim on the next session. Everything below them is optional.

1. **Create the GitHub repository and let the workflows run** (`docs/github-setup.md`).
   `ci.yml`, `deploy.yml` and `uptime.yml` are written and have never executed. Two
   incidents have "the guard existed and never ran" as a root cause. Nothing else on this
   page changes the project's reliability as much for as little work.
2. **Make the model-unavailable banner react** — a `refetchInterval` on `useModelHealth`
   *and* an invalidation of `['modelHealth']` when a call fails with `MODEL_UNAVAILABLE`,
   plus a Testing Library test for the transition rather than the steady state.
   (`2026-09-20-ollama-down-mid-run.md`, items 1 and 2.)
3. **Emit the per-model-call structured logs `docs/05` specifies** (`runId`, `stepIndex`,
   `latencyMs`, `toolName`, `parseOk`, `errorCode`…). Today a failed run produces no log
   line at all and Loki holds only HTTP access lines, so a third of the M14 observability
   stack is decorative. Two known call sites, and the numbers are already in hand for the
   metrics. (Item 6.)
4. **A Grafana alert rule on the 5xx rate** from `http_request_duration_seconds`. The
   series exists; nothing watches it, which is why the bad migration was invisible.
   (`2026-09-20-rename-final-output.md`, item 5.)
5. **Design, then maybe build, a provider probe that proves the model can *serve*** rather
   than that its tag is listed. Needs thought first: probing by generation on a timer
   competes with the learner for the GPU. (Item 7 — design before code.)
6. **Teach what the exercise found.** The curriculum lessons at the end of both
   postmortems: health ≠ correctness with the real `/health` body next to the real 500;
   expand/contract as a lesson rather than only a runbook; the trace-in-your-own-database
   argument; "test the transition, not the state".

## Backlog (unordered, optional)
- Email verification + password reset (Resend free tier) — see open decisions.
- Materialise `v_user_module_progress` if/when it matters; measure first.
- Cloud provider adapter (`CloudProvider`) behind the same interface, used only when a key is configured.
- Cloudflare Tunnel option so the deployed app can reach the learner's local Ollama.
- Real tokenizer comparison (`gpt-tokenizer`).
- Multi-user niceties (admin content reload endpoint, per-user content versions).
