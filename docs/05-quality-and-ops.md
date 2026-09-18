# 05 — Testing, CI/CD, SRE and the postmortem exercise

## Testing strategy

### Unit tests (Vitest) — fast, no I/O
| Area | What | Why it's the right unit-test target |
|---|---|---|
| `packages/nn-core` | Perceptron predict/train; MLP forward vs hand-computed values; **finite-difference gradient check** (relative error < 1e-6, fixed seed); XOR convergence; activation derivatives; BPE determinism and round-trip; attention rows sum to 1, uniform for identical keys; PCA recovers a known direction | Pure functions with known answers. This is the "verify backprop math against known values" requirement. |
| `packages/shared` | Every Zod contract accepts the fixtures in `content/` and rejects malformed ones; exercise-config schemas per kind | Cheap, catches content typos before seeding |
| `apps/api/src/auth` | argon2 hash/verify + `needsRehash`; TOTP against RFC 6238 vectors, window and replay; backup code format/uniqueness; AES-GCM round-trip and tamper rejection; cookie serialisation | Security primitives must be pinned |
| `apps/api/src/model` | `OllamaProvider` response mapping using recorded JSON fixtures (including tool_calls, malformed args, fenced-JSON fallback); `agentLoop` against `FakeProvider` scenarios: happy path, unknown tool, invalid args, max iterations, provider timeout, cancellation | The loop is the core of modules 5–6; scenarios double as SRE test cases |
| `apps/api/src/progress` | Quiz grading for each question kind (tolerance, multi-select exactness, text normalisation); completion rules | Business logic with edge cases |
| `apps/web` | Reducers/stores (`usePerceptronStore`), auto-check functions for exercise tasks, `AgentTrace` renders each step kind (Testing Library) | Only what has logic; no snapshot spam |

Coverage gate: 90 % lines on `nn-core` and `apps/api/src/{auth,model,progress}`; no global gate elsewhere.

### Integration tests (Vitest, real Postgres)
Run against a throwaway database (Testcontainers if Docker is available; otherwise the `docker compose` Postgres with a per-run schema). Each test file gets a fresh schema via migrations + seed; `buildApp()` is called with `MODEL_PROVIDER=fake`; requests via `app.inject()` (no network).
- Auth end-to-end at HTTP level: register → me → logout → login → enroll → confirm → logout → login → `mfa_required` → verify (TOTP computed in the test from the returned secret) → me. Then backup-code login, disable, lockout, CSRF header rejection, cookie flags.
- Content: modules list includes progress; `GET /quizzes/:id` never leaks `correct`/`explanation_md` (assert on serialised body); attempt grading persists and returns explanations.
- Progress: view `v_user_module_progress` reflects lesson/exercise/quiz completion; exercise `state` size limit enforced.
- Model routes: `/model/runs` with `FakeProvider` produces the expected `agent_run_steps` rows and rollup counters; SSE stream emits steps in order; `MODEL_PROVIDER=none` returns 503 with the right code; cancel sets status.
- Migrations: "migrate from empty → head → seed → re-seed is idempotent" (row counts unchanged).

### The one end-to-end test (Playwright, Chromium)
Against the built app started with `MODEL_PROVIDER=fake` and a seeded DB:
1. Register, land on dashboard.
2. Go to Security settings, enroll MFA: read the manual-entry secret from the page, compute a TOTP with `otplib` in the test, confirm, capture backup codes.
3. Log out; log in; get the MFA screen; enter a fresh TOTP; land on dashboard.
4. Open Module 1 → read lesson 1 (mark complete) → exercise: pick "blobs", click auto-run, wait for "100 %" → task badge turns green.
5. Take the Module 1 quiz with known-correct answers → "Passed" → dashboard shows Module 1 progress ring complete.
6. Open Module 5 exercise, run with the fake provider → trace shows model_call → tool_call → tool_result → final.
One test, because it exercises auth+MFA, content, progress, quiz, viz and the model path; more E2E tests would mostly re-test what integration tests cover, slowly.

## CI/CD (GitHub Actions)

### `ci.yml` — on pull_request and push to `main`
```
jobs:
  lint:     pnpm install --frozen-lockfile → eslint → prettier --check → tsc -b (all packages)
  unit:     pnpm test:unit (Vitest, all workspaces) → upload coverage
  integration:
    services: postgres:16 (healthcheck)
    env: DATABASE_URL, MODEL_PROVIDER=fake, SESSION_SECRET/MFA_ENCRYPTION_KEY = throwaway values generated in-job
    steps: migrate → pnpm test:integration
  e2e:
    needs: [unit, integration]
    services: postgres
    steps: pnpm build → migrate → seed → start API (serves SPA) → playwright test → upload trace on failure
  build-image:
    needs: [lint, unit, integration]
    docker buildx build → push ghcr.io/<user>/ai-concepts-lab:<sha> (and :main on main)
```
Caching: pnpm store, Playwright browsers, Docker layer cache (GHA cache backend).

### `deploy.yml` — on push to `main` after `ci.yml` succeeds (workflow_run) or manual dispatch
1. Re-tag the `:sha` image as `:prod`.
2. `curl -X POST "$RENDER_DEPLOY_HOOK_URL"` (Render pulls the image and runs the **pre-deploy command** `node apps/api/dist/db/migrate.js`, which is configured in the Render dashboard so migrations run once per deploy before the new instance starts).
3. Poll `GET https://<app>/health` until `status` is `ok` or `degraded` with the new `version` (the API exposes `GIT_SHA` from a build arg), fail after 5 min.
4. Post-deploy smoke: `GET /api/v1/modules` returns 6 modules.

### Secrets management
| Secret | Where | Notes |
|---|---|---|
| `GHCR` push | `GITHUB_TOKEN` (built-in) | packages: write permission on the job |
| `RENDER_DEPLOY_HOOK_URL` | GitHub Actions secret | only secret the pipeline holds |
| `DATABASE_URL` (Neon), `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `METRICS_TOKEN`, `APP_ORIGIN`, `MODEL_PROVIDER=none` | Render environment (dashboard / `render.yaml` with `sync:false`) | never in the repo; `config.ts` fails fast if missing |
| Local dev | `.env` (git-ignored) generated from `.env.example` by `pnpm setup:env` which mints random keys | |
Rotation runbook: change in Render → redeploy; `key_version` in `mfa_totp` allows re-encrypting secrets with a script.

Branch protection on `main`: PR required, `ci` checks required, no force-push. (Solo project, but this is the habit being learned.)

## SRE / observability

### Signals (what the agent/harness modules emit)
**Structured logs (pino, JSON, one line per event):** `reqId`, `userId`, `route`, `status`, `durationMs`; for model calls: `runId`, `stepIndex`, `provider`, `model`, `latencyMs`, `promptTokens`, `completionTokens`, `toolName`, `parseOk`, `errorCode`. Never log prompt contents at `info` (they're in the DB); `debug` may.

**Metrics (prom-client, `/metrics`):**
| Metric | Type | Labels | Alert on |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | route, method, status | p95 > 1 s (non-model routes) |
| `model_call_duration_seconds` | histogram | provider, model, outcome | p95 > 30 s for 15 min |
| `model_call_errors_total` | counter | provider, code (timeout/unavailable/http/parse) | rate > 20 % of calls over 10 min |
| `tool_call_parse_failures_total` | counter | tool, recovered | > 10 % of tool calls over 1 h |
| `tool_execution_duration_seconds` | histogram | tool, outcome | |
| `agent_run_iterations` | histogram (buckets 1,2,3,5,8,15) | kind | mass at 15 → runaway loops |
| `agent_runs_total` | counter | kind, status | `max_iterations`+`failed` share > 25 % |
| `model_provider_up` | gauge | provider | 0 for > 5 min *when the deployment is expected to have a model* |
| `db_pool_waiting`, `db_query_duration_seconds` | gauge/histogram | | |
| `sessions_active` | gauge | | (curiosity) |

**Traces in the DB:** `agent_runs`/`agent_run_steps` are the durable trace store; `/ops/sli` computes over them so the in-app `/ops` page works with zero external infra:
- run success rate (24 h), p50/p95 model latency, parse-failure rate per tool, iterations histogram, top error codes, tokens per run.

### Local observability stack (learning environment)
`docker compose --profile observability up`: Prometheus scraping `host.docker.internal:3000/metrics`, Grafana with a provisioned dashboard JSON (`docker/observability/grafana/dashboards/agent.json`) showing the table above, Loki + Promtail tailing the API's log file. Optional: Ollama's own `/api/ps` polled into `model_provider_loaded_models`.

### SLOs (documented in `docs/slo.md`, reviewed monthly)
| SLI | SLO | Window |
|---|---|---|
| `/health` availability (`ok` or `degraded`) | 99 % | 30 d |
| Non-model API p95 latency | < 800 ms | 30 d |
| Agent run success rate when provider healthy | ≥ 90 % | 7 d |
| Model call p95 latency (local) | < 30 s | 7 d |
Error-budget policy: if the availability budget is > 50 % consumed, the next milestone is a reliability task instead of a feature.

### Alerting (free-tier appropriate)
- **External uptime:** UptimeRobot (free) hitting `GET /health` every 5 min; `down` → email. `degraded` returns 200 so a missing model doesn't page.
- **Scheduled check with GitHub Actions (`uptime.yml`, every 30 min):** curl `/health` and `/ops/sli?token=` ; if `status=down`, or run success rate < 80 % with ≥ 10 runs, `gh issue create --label incident` (deduplicated by title). Free, versioned, and creates the paper trail for postmortems.
- **Local:** Grafana alert rules on the table above → Grafana's own notification list (or a desktop notifier). Enough to *practise* alert tuning.

### Runbooks (`docs/runbooks/`)
1. `model-provider-down.md` — symptoms (`model_provider_up=0`, 503 `MODEL_UNAVAILABLE`), check `ollama ps`, restart, verify `curl :11434/api/tags`, confirm banner clears; user impact and comms.
2. `slow-inference.md` — p95 breach: check CPU/GPU, other models loaded, `num_ctx`, `keep_alive`; mitigations (lower `maxTokens`, cap concurrent runs to 1 via a semaphore).
3. `parse-failure-spike.md` — after a model upgrade or tool-schema change; compare recent `agent_run_steps` with `parse_ok=false`; roll back model tag or fix schema descriptions.
4. `runaway-loops.md` — `max_iterations` share rising; inspect traces; tighten system prompt; lower cap.
5. `db-migration-failed.md` — how Render's pre-deploy command fails, how to inspect, roll back image, `drizzle-kit` down-migration policy (write a forward fix, never edit applied migrations).
6. `session-cleanup.md`, `run-retention.md` — housekeeping commands.
7. `secrets-rotation.md`.
Each runbook: Symptoms → Diagnose → Mitigate → Verify → Follow-ups.

## The deliberate "break something" postmortem exercise

### Primary scenario: a bad database migration (expand/contract done wrong)
**Set-up (later milestone, on the deployed app):** add a migration that renames `agent_runs.final_output` to `agent_runs.output` **and** ship it in the same deploy as code that still reads `final_output` in one place (the `/runs/:id` route) while the writer already uses `output`. Realistic: it is the classic "rename in one step" mistake.

**What breaks:** the pre-deploy migration succeeds. The new instance starts. Creating runs works; **opening any run page returns 500** (`column "final_output" does not exist`). `/health` stays `ok` (DB reachable), so uptime monitoring is silent. The GitHub Actions SLI check notices only if runs are being created and failing — they aren't failing, so it stays quiet too. Discovery comes from `http_request_duration_seconds{status="500"}` or from using the app.

**Learning goals:** why `/health` didn't catch it (health ≠ correctness), why renames need expand → migrate code → contract across *three* deploys, how to roll back an image when the schema has moved forward (you can't just redeploy the old image: it reads `final_output` too), writing a forward-fix migration under pressure, and adding a smoke test that hits `/runs/:id` post-deploy.

**Trigger checklist:** create branch `incident/rename-final-output`, write the migration + partial code change, merge, watch deploy go green, open a run page → 500. Start the incident clock. Create the GitHub issue with the `incident` label (manually or let the cron do it after you add a smoke check). Mitigate (forward-fix migration adding a generated column or view alias, or revert the migration with a new migration), verify, close.

**Blameless postmortem template (`docs/postmortems/TEMPLATE.md`):** Title · Date · Authors · Status · Summary (2 sentences) · Impact (who/what/how long) · Detection (how and how long after start) · Timeline (UTC, from first change to resolution) · Root cause(s) (technical, then process) · Contributing factors · What went well · What went poorly · Where we got lucky · Action items (owner, due, type: prevent/detect/mitigate) · Lessons for the curriculum (what to add to a lesson or runbook).

### Alternate scenario (run this one too, it's cheaper): Ollama dies mid-run
`ollama stop` (or kill the process) while a Module 5 run is in flight. Expected: the in-flight step fails with `MODEL_UNAVAILABLE`, the run is persisted with `status='failed'` and an `error` step, the SSE stream sends a terminal event, the UI shows the partial trace and the banner flips to "model unavailable" within one health-poll interval, `model_provider_up` goes to 0, Grafana alert fires after 5 min. Anything that *doesn't* happen in that list is a bug found by the exercise; the postmortem's action items become real tickets.
