# 06 — Build roadmap

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

## M1 — Hello world, end to end, deployed  (1–2 days)
**Goal:** the skeleton monorepo exists, runs locally, has CI, and a "hello" version is live on Render.
**Tasks:** `pnpm-workspace.yaml`; `apps/api` (Fastify, `GET /api/v1/health` → `{status:'ok'}`, pino, Zod config with `PORT`, `NODE_ENV`); `apps/web` (Vite React TS, one page fetching `/api/v1/health` via the Vite dev proxy); `packages/shared` (health response schema); `packages/nn-core` (empty with one exported `add` and one test so the pipeline is real); root ESLint/Prettier/tsconfig.base; `docker/Dockerfile` multi-stage producing one image where the API serves `apps/web/dist`; `docker/docker-compose.yml` with Postgres (unused yet); `.github/workflows/ci.yml` (lint, unit, build-image → GHCR); `deploy.yml` (Render deploy hook + health poll); Render web service created from the GHCR image; README with setup steps.
**Accept:** `pnpm dev` serves web+api locally; `docker build` + `docker run` serves both on one port; CI green; `https://<app>.onrender.com/api/v1/health` returns ok; `deploy.yml` succeeded once.
**Teaches:** monorepo, Docker multi-stage, CI, free-tier deploy, secrets (`RENDER_DEPLOY_HOOK_URL`).

## M2 — `nn-core`: the math, with tests  (2–3 days)
**Goal:** all from-scratch ML code for modules 1–3, framework-free, fully tested.
**Tasks:** `perceptron.ts` (predict, trainStep, trainEpoch, accuracy); `mlp.ts` (configurable layers, sigmoid/tanh, MSE + BCE loss, forward with cached activations, backward returning grads, `step(lr)`, seeded PRNG init); `gradcheck.ts` (central finite differences, relative error); `datasets.ts` (blobs, diagonal, xor, circle, moons, spiral, seeded); `bpe.ts` (train(corpus, numMerges), encode, decode, merges table); `attention.ts` (scaledDotProductAttention(Q,K,V, {scale, temperature}) → weights + output, softmax); `pca.ts` (mean-centre, covariance, top-2 components by power iteration, project); `linalg.ts` helpers. Tests per 05-quality-and-ops.md. Vitest with coverage; `nn-core` README documenting the API with the numeric worked example that Lesson 2.2 will reuse.
**Accept:** gradient-check test passes with rel. error < 1e-6; XOR converges; BPE round-trips; attention rows sum to 1; coverage ≥ 90 %.
**Teaches:** programming fundamentals, numerical testing, package design.

## M3 — Modules 1 & 2 in the browser (no DB, no auth)  (3–4 days)
**Goal:** the perceptron and MLP exercises and lessons are usable, with content loaded from static JSON/MD for now.
**Tasks:** React Router routes for `/modules`, `/modules/:slug`, lessons, exercise; Markdown+KaTeX lesson renderer; `useAnimationLoop`; Zustand stores; `PerceptronCanvas`, `NetworkGraph`, `BoundaryHeatmap`, `LossChart`; exercise task auto-checks (client-side) for modules 1–2; content files for modules 1–2 written in `content/` (lessons, exercise config, quiz JSON) and imported statically by the web app **temporarily** (a `content-static` loader that M6 replaces); quiz page with client-side grading **temporarily**.
**Accept:** you can read all lessons, complete both exercises' tasks, take both quizzes; Testing Library tests for auto-checks; visual check at 375 px width.
**Teaches:** frontend architecture, Canvas vs SVG, rendering loops, component boundaries.

## M4 — Database, migrations, seed  (2 days)
**Goal:** Postgres schema from 02-schema.md exists via Drizzle migrations; content seeds from `content/`.
**Tasks:** Drizzle schema for **all** tables/enums/view (yes, all, so later milestones only write code); `drizzle-kit generate` → commit SQL; `migrate.ts`; `seed.ts` that validates content with `packages/shared` schemas and upserts with uuid-v5 ids (idempotent); integration-test harness (`test/setup.ts` creating a fresh schema per file); `pnpm db:migrate|seed|studio` scripts; ERD exported to `docs/erd.md` via `drizzle-kit`/dbml.
**Accept:** `docker compose up -d postgres && pnpm db:migrate && pnpm db:seed` twice → same row counts; integration test "migrate+seed idempotent" passes in CI with the Postgres service; `EXPLAIN ANALYZE` of `v_user_module_progress` recorded in a comment.
**Teaches:** schema design in practice, migrations, seeding, test databases.

## M5 — Auth: register, login, sessions  (2–3 days)
**Goal:** real accounts and sessions per 03-auth-mfa.md, without MFA yet.
**Tasks:** `password.ts` (argon2id), `session.ts` (token mint/hash/lookup/touch/revoke), cookie plugin, CSRF header + Origin check, rate limits, lockout, `auth_events`, routes `register/login/logout/me/password/sessions`, `requireAuth` guard; frontend: login/register pages, `RequireAuth`, `['me']` query, settings page listing sessions; `X-Requested-With` added by the fetch client.
**Accept:** integration tests listed in 05-quality-and-ops.md (auth without MFA parts) pass; cookie flags asserted; lockout test with fake timers; `pnpm audit` clean.
**Teaches:** authentication, sessions, threat modelling, rate limiting.

## M6 — MFA (TOTP + backup codes)  (2 days)
**Goal:** complete the flows in 03-auth-mfa.md.
**Tasks:** AES-GCM helper with `MFA_ENCRYPTION_KEY`; `totp.ts` (otplib, window, replay via `last_used_step`); `backupCodes.ts`; routes `mfa/enroll|confirm|verify|disable|backup-codes/regenerate`; pending-session semantics in the guard; frontend: `/login/mfa`, enrollment wizard (QR → code → backup codes download), disable flow, "remaining backup codes" nag.
**Accept:** RFC 6238 vector test; replay and window tests; full HTTP-level auth+MFA integration test; manual test with a real authenticator app documented in README.
**Teaches:** MFA, crypto-at-rest, step-up auth.

## M7 — Content, progress and quizzes from the API  (2–3 days)
**Goal:** replace M3's static loaders; progress is persisted; quizzes graded server-side.
**Tasks:** content routes (with the "never leak `correct`" test); progress routes; `completion_rule` evaluation; quiz attempt grading per question kind; `GET /progress` from the view; frontend switches to TanStack Query; dashboard with progress rings; exercise state debounce-save; module gating UX (none: all modules open, but progress shown).
**Accept:** integration tests for content/progress/quiz; the M3 flows work end-to-end against the DB; delete the static loaders.
**Teaches:** REST design, server-side validation, query/mutation patterns.

## M8 — Module 3 (tokenizer, embeddings, attention)  (3 days)
**Goal:** the LLM-internals module is complete, model-optional.
**Tasks:** `TokenChips`, `MergeTable`, `EmbeddingScatter`, `AttentionHeatmap`, `AttentionArcs`; `POST /api/v1/model/embed` route (provider stub returns 503 until M9; UI uses fallback); script `pnpm content:embeddings` that generates `embeddings-precomputed.json` with Ollama; lessons 3.1–3.4; quiz; tasks/auto-checks.
**Accept:** all three tabs work with `MODEL_PROVIDER=none`; nn-core tests already cover the math; a11y pass on the heatmap (values readable on hover/focus).
**Teaches:** data-viz components, graceful degradation.

## M9 — `ModelProvider` + Module 4  (3 days)
**Goal:** the LLM seam exists with Ollama and Fake implementations; prompting/structured-output module works.
**Tasks:** `provider.ts` interface (from 01-architecture.md); `ollama.ts` (mapping, timeouts, fenced-JSON tool-call recovery, embed, health) tested with M0 fixtures; `fake.ts` with scenario table; `none`; `POST /model/chat` logging a run of kind prompt/structured; `GET /model/health`; the UI banner; Module 4 lessons, playground, task checks, JSON-schema editor with Zod validation; `agent_runs` written for every call.
**Accept:** provider unit tests; integration tests with fake; manual run against Gemma recorded in `docs/spike-notes.md` (latency, tokens); `MODEL_PROVIDER=none` on Render shows the banner.
**Teaches:** interface-driven design, adapters, test doubles.

## M10 — Agent loop + Module 5  (3–4 days)
**Goal:** server-side agent loop with tool catalog, mock tools, SSE streaming, trace viewer.
**Tasks:** `tools/` (catalog with Zod arg schemas, `lookup_glossary` querying lessons), mock-tool executor; `agentLoop.ts` per 01-architecture.md with guardrails and step persistence; `POST /model/runs`, SSE `events`, `cancel`, list/get; concurrency semaphore (1 run at a time per instance); `AgentTrace`, `ToolSchemaBuilder`, `/runs`, `/runs/:id`; Module 5 lessons, tasks, quiz.
**Accept:** loop scenarios (happy, unknown tool, invalid args, max-iterations, timeout, cancel) pass with fake; a real run against Gemma completes the `compound-interest` task; SSE reconnect resumes from `Last-Event-ID`.
**Teaches:** async control flow, streaming, persistence of partial state, guardrails.

## M11 — Harness exercise + Module 6  (3 days)
**Goal:** the learner can implement the loop in the browser and pass scripted checks.
**Tasks:** `harnessRunner.worker.ts` (sandboxed execution of learner code via `new Function` inside a Worker with a restricted global, message protocol for `model.chat`/tools/steps/logs, timeout); `POST /model/runs/:id/steps` (validated, capped); CodeMirror editor with starter code; scripted fake inside the worker; the three checks; Module 6 lessons including the "real harnesses" lesson; quiz.
**Accept:** reference solution stored in `apps/web/src/features/exercises/harness/reference.ts` passes all checks in a Vitest test that drives the worker protocol; a broken solution fails the right check; real-model run shows in `/runs/:id`.
**Teaches:** sandboxing, worker messaging, writing a spec that checks itself.

## M12 — Test completeness and pipeline hardening  (2 days)
**Goal:** the full test pyramid and CI from 05-quality-and-ops.md.
**Tasks:** the Playwright E2E; coverage gates; `e2e` CI job; branch protection; dependabot config; `pnpm audit` in CI (fail on high); build provenance (`GIT_SHA` build arg surfaced in `/health`).
**Accept:** CI runs lint/unit/integration/e2e/build on PRs; E2E green in CI; `main` protected.
**Teaches:** test strategy, CI as gatekeeper.

## M13 — Production hardening on Render + Neon  (2 days)
**Goal:** the deployed app is real: Neon Postgres, migrations as pre-deploy step, secrets, security headers.
**Tasks:** Neon project + `DATABASE_URL` (pooled); Render pre-deploy command; `@fastify/helmet` CSP tuned for the SPA; HTTPS-only cookies; `APP_ORIGIN`; `render.yaml`; post-deploy smoke in `deploy.yml`; seed in production (one-off job); session/run cleanup as a Render cron job or GitHub Actions schedule calling an authenticated maintenance endpoint; backups: Neon point-in-time restore noted in runbook.
**Accept:** register + MFA works on the public URL; modules 1–3 fully usable; 4–6 show the banner; `deploy.yml` smoke passes; secrets nowhere in git (`gitleaks` in CI).
**Teaches:** DevOps, environments, secrets, security headers.

## M14 — Observability, SLOs, alerting, runbooks  (3 days)
**Goal:** everything in the SRE section exists.
**Tasks:** prom-client metrics per table; `/metrics` with token; `/ops/sli` + `/ops` page; compose `observability` profile with Prometheus/Grafana/Loki and a provisioned dashboard; Grafana alert rules; UptimeRobot on `/health`; `uptime.yml` scheduled check creating GitHub issues; `docs/slo.md`; the seven runbooks; log redaction tests.
**Accept:** dashboard shows a real run's latency/tokens/iterations; killing Ollama flips `model_provider_up` and fires the Grafana alert; `uptime.yml` opens an issue when pointed at a dead URL (test it once).
**Teaches:** SRE fundamentals.

## M15 — Break it on purpose: the postmortem exercise  (1 day + write-up)
**Goal:** run the primary scenario (bad migration) and the alternate (Ollama down mid-run) from 05-quality-and-ops.md; write two blameless postmortems; turn action items into issues; implement at least one (the post-deploy smoke test for `/runs/:id`, and expand/contract documentation in the migration runbook).
**Accept:** `docs/postmortems/2026-xx-xx-rename-final-output.md` and `...-ollama-down.md` complete per template; action items tracked; the incident is no longer reproducible after the fixes.
**Teaches:** incident response, blameless culture, feedback into the curriculum.

---

## After M15 (backlog, unordered)
- Email verification + password reset (Resend free tier) — see open decisions.
- Materialise `v_user_module_progress` if/when it matters; measure first.
- Cloud provider adapter (`CloudProvider`) behind the same interface, used only when a key is configured.
- Cloudflare Tunnel option so the deployed app can reach the learner's local Ollama.
- Real tokenizer comparison (`gpt-tokenizer`).
- Multi-user niceties (admin content reload endpoint, per-user content versions).
