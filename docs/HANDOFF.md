# Handoff Brief — AI Concepts Lab

Paste this into a new session (Opus/Sonnet) to start implementation. The full design lives in `docs/01`–`07` in this repo; read the file named in each milestone before coding it. Start with **M0**, then **M1**.

## What this is
A solo learning project: an interactive web app teaching AI/ML concepts (neurons → neural nets → LLM internals → prompting → agents → harnesses) that is *also* the vehicle for learning the SDLC (fundamentals, DB design, full-stack, auth+MFA, DevOps, SRE). Optimise for learning per hour, free/open-source end to end, local LLM only.

## Stack (decided — do not re-litigate; deviations need an ADR in `docs/adr/`)
- **TypeScript monorepo** (pnpm workspaces): `apps/api` (Fastify 5 + Zod type provider, pino, prom-client), `apps/web` (React 19, Vite, React Router 7, TanStack Query 5, Zustand for playground state, Tailwind, CodeMirror 6, react-markdown + KaTeX), `packages/nn-core` (pure TS ML math, zero deps), `packages/shared` (Zod contracts + types), `content/` (Markdown/JSON curriculum, seeded into DB).
- **PostgreSQL 16 + Drizzle ORM**; migrations as committed SQL; uuid-v5 ids for seeded content (idempotent seeds).
- **Auth:** Postgres-backed sessions (opaque cookie `sid`, `HttpOnly; Secure; SameSite=Lax`, store `sha256(token)`), argon2id passwords, CSRF via `X-Requested-With: fetch` + Origin check, rate limits + lockout, audit table. **MFA:** TOTP (otplib, ±1 window, replay-protected via `last_used_step`), secret AES-256-GCM at rest, 10 single-use backup codes (argon2 hashed), pending-session state between login step 1 and 2.
- **LLM:** Ollama `gemma4:e4b` (+ `nomic-embed-text`) behind a `ModelProvider` interface (`chat`, `embed`, `health`) with implementations `ollama | fake | none` chosen by `MODEL_PROVIDER`. Nothing outside `apps/api/src/model/` may know about Ollama. Deployed instance runs `none` (modules 4–6 show a "run locally" banner).
- **Prod:** one Docker image (API serves the built SPA), Render free web service + Neon free Postgres, migrations as Render pre-deploy command. **CI:** GitHub Actions lint → unit → integration (Postgres service) → e2e (Playwright, fake provider) → build → GHCR; `deploy.yml` hits Render deploy hook and polls `/health`.
- **Tests:** Vitest unit (nn-core gradient check is the flagship), Vitest integration with real Postgres via `app.inject()`, exactly one Playwright E2E (register → MFA enroll → login with TOTP → Module 1 exercise → quiz → agent run with fake).
- **Observability:** pino JSON logs, Prometheus metrics (`model_call_duration_seconds`, `tool_call_parse_failures_total`, `agent_run_iterations`, `agent_runs_total{status}`, `model_provider_up`…), durable traces in `agent_runs`/`agent_run_steps`, in-app `/ops` SLI page, local Grafana/Prometheus/Loki compose profile, UptimeRobot + a GitHub Actions cron that opens issues.

## Schema (condensed; full in `docs/02-schema.md`)
- `users`(id, email citext uq, password_hash, display_name, mfa_enabled, failed_login_count, locked_until, timestamps)
- `mfa_totp`(user_id pk, secret_ciphertext/iv/tag, key_version, confirmed_at, last_used_step) · `mfa_backup_codes`(id, user_id, code_hash, used_at)
- `sessions`(id = sha256 token, user_id, mfa_verified_at, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at) · `auth_events`(id, user_id?, event_type enum, ip, ua, metadata jsonb, created_at)
- `modules`(id, slug uq, title, summary, order_index, requires_model, is_published, content_version)
- `lessons`(id, module_id, slug, title, order_index, body_md, estimated_minutes)
- `exercises`(id, module_id, lesson_id?, slug, title, kind enum, config jsonb, order_index, completion_rule jsonb)
- `quizzes`(id, module_id uq, title, pass_threshold) · `quiz_questions`(id, quiz_id, order_index, kind enum, prompt_md, options jsonb, correct jsonb, explanation_md, points)
- `user_lesson_progress`(user_id, lesson_id, status, completed_at) · `user_exercise_progress`(user_id, exercise_id, status, state jsonb, tasks_completed text[], completed_at)
- `quiz_attempts`(id, user_id, quiz_id, started_at, submitted_at, score_points, max_points, passed) · `quiz_attempt_answers`(attempt_id, question_id, answer jsonb, is_correct, points_awarded)
- `agent_runs`(id, user_id, exercise_id?, kind enum, provider, model, status enum, system_prompt, user_prompt, tools jsonb, options jsonb, max_iterations, iteration_count, tool_call_count, tool_parse_failure_count, prompt/completion_tokens_total, model_latency_ms_total, final_output, error_code, error_message, started_at, finished_at, request_id)
- `agent_run_steps`(id, run_id, step_index, kind enum[model_call|tool_call|tool_result|final|error], iteration, content, tool_name, tool_args jsonb, tool_args_raw, parse_ok, tool_result jsonb, is_error, latency_ms, prompt_tokens, completion_tokens, raw jsonb, created_at)
- View `v_user_module_progress` (computed; materialise only if measured slow).
- Rule: `GET /quizzes/:id` never serialises `correct` or `explanation_md` (tested).

## API (REST `/api/v1`, JSON, cookie session; full in `docs/01-architecture.md`)
Auth: `POST auth/register|login|logout`, `GET auth/me`, `POST auth/mfa/enroll|confirm|verify|disable|backup-codes/regenerate`, `PATCH auth/password`, `GET/DELETE auth/sessions`. Content: `GET modules`, `modules/:slug`, `lessons/:id`, `exercises/:id`, `quizzes/:id`. Progress: `PUT progress/lessons/:id`, `PUT progress/exercises/:id`, `GET progress`, `POST quizzes/:id/attempts`. Model: `POST model/chat`, `POST model/runs`, `POST model/runs/:id/steps`, `POST model/runs/:id/cancel`, `GET model/runs[/:id]`, `GET model/runs/:id/events` (SSE), `GET model/health`, `POST model/embed`. Ops: `GET health` (`ok|degraded|down`), `GET metrics` (token), `GET ops/sli`. Errors: `{error:{code,message,details?}}`; every response has `x-request-id`; non-GET requires `X-Requested-With: fetch`.

## Curriculum (full in `docs/04-curriculum.md`)
1 `neurons` (perceptron canvas) · 2 `neural-networks` (MLP graph + boundary heatmap + gradient check) · 3 `how-llms-work` (from-scratch BPE tokenizer, embeddings via Ollama with precomputed fallback + PCA, toy attention heatmap) · 4 `prompting` (playground + JSON-schema structured output validated by Zod) · 5 `agents` (server-side loop, tool catalog + mock tools, SSE trace viewer) · 6 `harnesses` (learner implements `runAgent` in a Web Worker; scripted checks; lesson on what Claude Code-style harnesses add). Each module: 2–4 lessons, one exercise with auto-checked tasks, one quiz at 70 %.

## Roadmap (full in `docs/06-roadmap.md`)
M0 model spike + fixtures · M1 monorepo hello world, Docker, CI, deployed to Render · M2 `nn-core` with gradient-check tests · M3 Modules 1–2 UI (static content) · M4 Drizzle schema, migrations, seed, integration harness · M5 auth + sessions · M6 MFA · M7 content/progress/quiz API + frontend wiring · M8 Module 3 · M9 `ModelProvider` (ollama/fake/none) + Module 4 · M10 agent loop, tools, SSE, trace viewer + Module 5 · M11 harness worker exercise + Module 6 · M12 E2E + pipeline hardening · M13 prod hardening (Neon, pre-deploy migrations, helmet, secrets) · M14 metrics, dashboards, SLOs, alerting, runbooks · M15 deliberate bad-migration incident + Ollama-down incident, two blameless postmortems.

## Open decisions (full in `docs/07-open-decisions.md`)
Deployed model access (recommend `none` now, Cloudflare Tunnel later) · Render+Neon vs Fly (recommend Render+Neon) · email verification/reset deferred · embedding model `nomic-embed-text` · real-tokenizer comparison deferred · Gemma tool-calling reliability verified in M0 (fallback: prompt-based JSON protocol behind the same interface).

## How to work each milestone
Branch `mNN-<slug>` → implement → tests → CI green → PR → squash-merge. Read the referenced design doc first. Don't add dependencies outside the stack list without asking. Keep `docs/` truthful: if reality diverges, write an ADR. **Begin with M0.**
