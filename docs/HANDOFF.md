# Handoff Brief — AI Concepts Lab (as built)

**Read this first.** It describes the system that exists, not the one that was designed.
Where the two differ, the difference is stated here and the reasoning is in an ADR. The
original design lives in `docs/01`–`07`; `docs/06-roadmap.md` now carries a **Done**
paragraph per milestone saying what actually happened.

**Status: complete.** All sixteen milestones (M0–M15) are implemented and merged on
`main`. The whole gate is green locally. Nothing is deployed anywhere.

---

## What this is

A solo learning project: an interactive web app that teaches AI/ML concepts (neurons →
neural nets → LLM internals → prompting → agents → harnesses) and is *also* the vehicle
for learning the full SDLC — fundamentals, database design, full-stack, auth + MFA,
DevOps, SRE, incident response. Free and open-source end to end, local LLM only.

Six modules, **23 lessons, 6 exercises, 48 quiz questions**, seeded into Postgres from
Markdown and JSON in `content/`.

## The 60-second orientation

```bash
pnpm install
pnpm setup:env          # writes .env with freshly minted keys, if you have no .env
pnpm db:up              # Postgres 16 in Docker
pnpm db:migrate && pnpm db:seed
pnpm dev                # Vite on 5173 proxying the API on 3000
```

For the model paths (modules 4–6) you also need Ollama running with `gemma4:latest`.
Without it the app works and modules 4–6 show a "run this locally" banner.

The full gate, which is what "green" means on this project:

```bash
pnpm verify             # lint → prettier --check → tsc -b → unit → integration
pnpm test:e2e           # one Playwright journey against the built app
pnpm test:coverage:gate # the 90 % gate; needs Postgres
docker build -f docker/Dockerfile -t ai-concepts-lab .
pnpm obs:up             # optional: Prometheus + Grafana + Loki + Promtail
```

## The two things that will surprise you

**1. Nothing is deployed, and no CI has ever run.** There is no git remote, no GitHub
repository, no Render service and no Neon database. `ci.yml`, `deploy.yml` and
`uptime.yml` are written, reviewed and complete — and have never executed.
`render.yaml` exists and has never been applied. Every "CI green" in this project's
history means a laptop.

This is not a footnote. It is the root cause of two separate incidents: the Docker image
that could not build for four milestones (ADR 0004's addendum) and the bad-migration
outage in M15. **Creating the repository — `docs/github-setup.md` has the exact
commands — is the highest-value single action left.**

**2. The model is `gemma4:latest`, not `gemma4:e4b`.** The designed tag was never
installed. Everything — fixtures, provider tests, latency numbers, Prometheus bucket
boundaries — is measured against `gemma4:latest` (8B, Q4_K_M, 131k context). It is a
*thinking* model, which dominated latency until `think: false` was sent on every request.

## Stack, as built

| Layer | What |
| --- | --- |
| Monorepo | pnpm workspaces, TypeScript everywhere, Node 22 |
| `apps/api` | Fastify 5 + `fastify-type-provider-zod`, pino, prom-client, `@fastify/{cookie,cors,helmet,rate-limit,static}`, argon2, otplib, qrcode, postgres.js + Drizzle 0.45 |
| `apps/web` | React 19, Vite, React Router 7, TanStack Query 5, Zustand, Tailwind, react-markdown + KaTeX. **No CodeMirror** — the harness editor is a `<textarea>` (ADR 0003 § 1) |
| `packages/nn-core` | Pure TypeScript ML maths. **Zero dependencies**, as designed |
| `packages/shared` | Zod contracts shared by the API and the web app. Only dependency is `zod` |
| `content/` | The curriculum as Markdown/JSON. **Also a build input** since M8 (Vite `?raw`), which is why the Dockerfile copies it |
| Database | PostgreSQL 16, Drizzle migrations as committed SQL, uuid-v5 ids for seeded content so seeds are idempotent |
| Model | Ollama `gemma4:latest` + `nomic-embed-text:latest`, behind a `ModelProvider` interface with `ollama \| fake \| none`. **Nothing outside `apps/api/src/model/` mentions Ollama** — still true, check it stays true |
| Prod (unbuilt) | One Docker image, the API serves the built SPA. Render + Neon, migrations as a pre-deploy command |

## Tests, as they actually count

| Suite | Files | Tests | Notes |
| --- | --- | --- | --- |
| `packages/nn-core` | 12 | 204 | The finite-difference gradient check is the flagship |
| `packages/shared` | 4 | 79 | Every Zod contract against the real `content/` fixtures |
| `apps/api` unit | 23 | 441 | Provider mapping from M0 fixtures, the agent loop against `FakeProvider`, auth primitives |
| `apps/web` unit | 24 | 278 | Stores, auto-checks, trace rendering (Testing Library) |
| **Unit total** | **63** | **1002** | `pnpm test`, ~60 s |
| Integration | 12 | 166 | Real Postgres, throwaway database per file, `app.inject()` |
| E2E | 1 | 1 | Playwright, Chromium, ~29 s, against the built app with `MODEL_PROVIDER=fake` |

Coverage gate (`pnpm test:coverage:gate`, 35 files / 607 tests): `auth` 92.97 %,
`model` 95.21 %, `progress` 97.24 % lines, thresholds 90. It runs over the unit **and**
integration suites, because Fastify route plugins have no honest unit test — ADR 0004 § 1.
`nn-core`'s own 90 % gate stays in the unit job.

`MODEL_PROVIDER=fake` everywhere in tests. No test has ever called a real model.

## The six ADRs

Read these before changing anything they touch; each records a place where the design docs
and reality diverged and why.

| ADR | Milestone | What it records |
| --- | --- | --- |
| **0001** | M7 | `v_user_module_progress` counted lessons wrong — a join fan-out multiplied the counts. Rewritten with lateral subqueries in migration `0001`. |
| **0002** | M10 | Three agent-tooling deviations: a sixth catalog tool `flaky_service` for the failure-path lesson, `parse_ok` counting only provider-side parse failures, and `GET /model/tools` added to the route table. |
| **0003** | M11 | Four harness deviations: a `<textarea>` instead of CodeMirror 6, two worker tools instead of three, `toolDefs` in `runAgent`'s options, two small API additions found by running it. |
| **0004** | M12 | Five pipeline deviations — the coverage gate spanning both suites being the important one — plus **the addendum**: `docker build` had been broken since M8 and the CI job that would have caught it had never run. |
| **0005** | M13 | Seven production-hardening decisions: `MAINTENANCE_TOKEN` failing closed, the CSP split (`style-src` keeps `'unsafe-inline'`, `script-src` does not), a separate looser CSP for the harness worker, `GIT_SHA` provenance, the limits of the post-deploy smoke check, pool of 3 with prepared statements off for a pooled endpoint. |
| **0006** | M14 | Five observability deviations: `/metrics` at two paths, failing closed without a token, `/ops/sli` accepting the metrics bearer, `db_query_duration_seconds` covering only instrumented queries, two accepted palette findings. Also notes that `/health` never returns `degraded`. |

## Measured model behaviour (`docs/spike-notes.md` has the tables)

- **Cold load 19–40 s**; the first agent run of a session measured **68 s** wall clock.
- **Warm model call 6–45 s**; inside a 2-iteration agent run, roughly **9–25 s per call**.
- **Tool execution is 2–9 ms.** Inference is **over 99.9 %** of an agent run's wall clock.
- **Tool choice is reliable: 13/13** correct decisions to call a tool on the real model.
  The prompt-based fallback in `docs/07-open-decisions.md` was never needed.
- **Structured output is not 100 %** and needs a retry; `think` and `format` together are
  refused outright.
- **Attaching the whole catalog is expensive**: 6 tools instead of 1 cost **4.6× the
  prompt tokens and 3× the latency**, for five tools the model never called. This number
  is the reason the exercise tells learners to tick only what they need.

## Operations

- `GET /api/v1/health` → `{status, version, checks:{db, schema}}`. `ok` or `down`; it
  never returns `degraded` (ADR 0006). **`checks.schema` is new in M15** and compares
  drizzle's declared columns with Postgres's actual ones; a mismatch is `down`.
- `GET /metrics` (root and `/api/v1`), bearer `METRICS_TOKEN`, fails closed with 503 if the
  token is unset.
- `GET /api/v1/ops/sli` — the whole in-app dashboard, computed in one SQL statement over
  `agent_runs`/`agent_run_steps`. Works with **zero external monitoring infrastructure**,
  which is the point. Session **or** `METRICS_TOKEN`.
- `pnpm obs:up` — Prometheus, Grafana (anonymous admin on :3001), Loki, Promtail, with a
  provisioned dashboard and five alert rules. **On an 8 GB machine this competes with the
  model for memory and the model loses** — see `docker/observability/README.md`.
- `docs/slo.md` — four SLOs, what each one is measured from, and an honest "what is not
  measured" section.
- `docs/runbooks/` — eight runbooks, each Symptoms → Diagnose → Mitigate → Verify →
  Follow-ups. Four of them were corrected by M15 because the incidents proved them wrong.
- `docs/postmortems/` — `TEMPLATE.md` and two real, blameless postmortems from M15.

## Known gaps, honestly

In rough order of how much they matter:

1. **No repository, no CI runs, no deployment.** Above.
2. **No per-model-call structured logging.** `docs/05` specifies `runId`, `stepIndex`,
   `latencyMs`, `toolName`, `parseOk`, `errorCode` on every model call. None of it exists.
   A run that fails with `MODEL_UNAVAILABLE` produces **no log line at all**, so Loki holds
   only HTTP access lines and contributed nothing during a real incident. This is the
   largest genuine gap the M15 exercise found and it is not covered by ADR 0006.
3. **The "model unavailable" banner never flips on an open page.** `useModelHealth` has no
   `refetchInterval` and `refetchOnWindowFocus` is off globally, so the banner only
   appears on mount. Verified over 121 s with a failed run visible on screen.
4. **`model_provider_up` means "the tag is listed", not "the model can serve".** Observed
   green for 3 min 40 s while every call returned 503 because the model could not be
   loaded into memory.
5. **No alert on HTTP 5xx.** The Prometheus series exists; nothing watches it. This is why
   the M15 bad migration was invisible to every monitor.
6. `POST /model/runs` answers 202 and fails the run asynchronously when the provider is
   down — `/model/chat` correctly answers 503. The runbook now says so.
7. Email verification and password reset were deferred by design
   (`docs/07-open-decisions.md`).

## What a future session needs to know

- **Branch `mNN-<slug>`, never commit to `main`.** `CONTRIBUTING.md` has the workflow.
- **Deviations need an ADR** in `docs/adr/`. Six exist; number the next one 0007.
- **Do not add dependencies** outside the stack list without asking.
- **`MODEL_PROVIDER=fake` in every test.** Never call a real model from a test.
- **Migrations are forward-only.** Never edit an applied migration; fix with a new one.
  `docs/runbooks/db-migration-failed.md` explains why at length, with a worked
  expand/contract example for exactly the rename M15 broke on purpose.
- **The learner is optimising for understanding, not speed.** Explain non-obvious choices
  in code comments and PR descriptions. The existing code does this heavily; match it.
- **`COOKIE_SECURE=false` is required** whenever you run `NODE_ENV=production` over plain
  `http://127.0.0.1`, or the session cookie is silently dropped. It is the single most
  confusing failure this project can produce (ADR 0004, smaller notes).

## Where to look for what

| Question | File |
| --- | --- |
| What was the plan, and what actually happened? | `docs/06-roadmap.md` |
| Routes, layering, the `ModelProvider` seam | `docs/01-architecture.md` |
| Tables, columns, indexes, the progress view | `docs/02-schema.md`, `docs/erd.md` |
| Auth and MFA flows in detail | `docs/03-auth-mfa.md` |
| Module, lesson and exercise design | `docs/04-curriculum.md` |
| Test strategy, CI, SRE, the postmortem exercise | `docs/05-quality-and-ops.md` |
| Open questions nobody has answered | `docs/07-open-decisions.md` |
| Real measurements against the real model | `docs/spike-notes.md` |
| Why the code differs from the docs | `docs/adr/` |
| What to do at 2am | `docs/runbooks/` |
| What broke, and what it taught | `docs/postmortems/` |
| Setting up the GitHub repository | `docs/github-setup.md` |
