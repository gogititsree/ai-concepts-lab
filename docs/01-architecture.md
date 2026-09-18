# 01 — Architecture

## The one-paragraph version

AI Concepts Lab is a single-origin web app: a **React SPA** served by a **Fastify (Node/TypeScript) API** that talks to **PostgreSQL** and, for the LLM modules, to a **local Ollama** instance through a narrow `ModelProvider` interface. The from-scratch ML math lives in a framework-free TypeScript package (`nn-core`) that is imported by the browser for visualizations *and* by Vitest for unit tests, so the same code that draws the decision boundary is the code the gradient-check test proves correct. Content (lessons, exercises, quizzes) is authored as Markdown/JSON in the repo and seeded into Postgres; progress, quiz attempts and agent-run traces are runtime data in Postgres. Everything is one language (TypeScript), one repo (pnpm workspaces), one container in production.

## Diagram (text form)

```
┌─────────────────────────────── Browser ────────────────────────────────┐
│  React SPA (apps/web)                                                  │
│   ├─ routes: /modules/:slug/{lessons,exercise,quiz}, /runs/:id, /auth  │
│   ├─ TanStack Query  ── fetch /api/v1/*  (cookie session)              │
│   ├─ visualizations: Canvas (perceptron, MLP boundary)                 │
│   │                  SVG (network graph, attention heatmap)            │
│   │                  DOM  (tokenizer, agent trace timeline)            │
│   ├─ packages/nn-core (perceptron, MLP+backprop, BPE, attention, PCA)  │
│   └─ Module 6 harness: learner JS runs in a Web Worker,                │
│      calls POST /api/v1/model/chat with run_id for tracing            │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ same origin (Vite proxy in dev,
                               │ API serves built SPA in prod)
┌──────────────────────────────▼─────────────────────────────────────────┐
│  Fastify API (apps/api)  — Node 22, TypeScript, Zod-validated routes   │
│   ├─ /auth/*        sessions (Postgres-backed), argon2id, TOTP MFA     │
│   ├─ /modules,/lessons,/exercises,/quizzes   content delivery         │
│   ├─ /progress/*, /quizzes/:id/attempts      progress + grading       │
│   ├─ /model/chat, /model/runs/*              LLM proxy + agent loop   │
│   ├─ /health, /metrics (Prometheus), /ops/*  SRE surface              │
│   ├─ ModelProvider interface                                           │
│   │     ├─ OllamaProvider   → http://localhost:11434 (dev / local)     │
│   │     ├─ FakeProvider     → scripted responses (tests, CI, demos)    │
│   │     └─ (later) CloudProvider                                       │
│   ├─ Tool catalog (server-side, allow-listed) + learner mock tools     │
│   └─ pino structured logs, prom-client metrics                        │
└──────────┬───────────────────────────────────────┬─────────────────────┘
           │ Drizzle ORM                            │ HTTP JSON
┌──────────▼──────────────┐              ┌──────────▼──────────────┐
│ PostgreSQL 16           │              │ Ollama  (gemma4:e4b)    │
│  content (seeded)       │              │  /api/chat (+tools,     │
│  users/sessions/mfa     │              │   format=json-schema)   │
│  progress/quiz attempts │              │  /api/embed             │
│  agent_runs/steps       │              │  /api/tags (health)     │
└─────────────────────────┘              └─────────────────────────┘
```

## Stack decisions (opinionated, with reasons)

| Layer | Choice | Why this and not the alternative |
|---|---|---|
| Language | TypeScript everywhere | The neural-net math must run in the browser (visualization) and in tests. One language means `nn-core` is written once. A Python backend would force the math to be duplicated or the viz to call an API for every training step. |
| Monorepo | pnpm workspaces | Lightweight, no Nx/Turbo needed at this size. Teaches package boundaries. |
| Backend | Fastify 5 + `fastify-type-provider-zod` | Schema-validated routes out of the box, which teaches API contracts. Express is more tutorial-heavy but validation is bolted on. Zod is also used in the frontend and for validating LLM tool-call arguments, so one validation library covers the whole stack. |
| ORM / migrations | Drizzle ORM + drizzle-kit | SQL-shaped (you still learn SQL), migrations are plain `.sql` files you can read and break on purpose (see postmortem exercise). Prisma hides more. |
| Database | PostgreSQL 16 | Free everywhere, `jsonb` for flexible exercise config and run traces, enums, views. |
| Frontend | React 19 + Vite + TypeScript + React Router 7 + TanStack Query 5 + Tailwind | Most transferable skill set. TanStack Query removes most hand-written state management. |
| Client state | TanStack Query for server state; Zustand only for exercise-local playground state | Avoids Redux ceremony. |
| Code editor | CodeMirror 6 | Lighter than Monaco; used in Module 6 harness exercise and the tool-schema editor. |
| Auth | Server-side sessions in Postgres, cookie-based | See 04-auth-mfa.md for the session-vs-JWT argument. |
| Password hashing | argon2id (`argon2` npm) | Current OWASP recommendation. |
| TOTP | `otplib` + `qrcode` | RFC 6238; backup codes generated with `crypto.randomBytes`. |
| LLM | Ollama, `gemma4:e4b`, native tool calling and JSON-schema `format` | Zero cost. Isolated behind `ModelProvider`. |
| Logging / metrics | pino (JSON) + prom-client | Industry-standard, free, and Grafana/Loki/Prometheus run locally via a docker-compose profile. |
| Tests | Vitest (unit + integration), Playwright (one E2E), Testcontainers or compose Postgres for integration | |
| CI/CD | GitHub Actions → GHCR image → Render deploy hook | |
| Hosting | Render free web service (Docker) + Neon free Postgres | Only combo that is genuinely $0 with no card and no 30-day DB expiry at time of writing. Fly.io is the alternative (see 11-open-decisions.md). |

## Repository layout

```
ai-concepts-lab/
├─ apps/
│  ├─ api/                 Fastify app; in prod also serves apps/web/dist
│  │  ├─ src/
│  │  │  ├─ app.ts         buildApp(): registers plugins + routes (used by tests)
│  │  │  ├─ server.ts      listen()
│  │  │  ├─ config.ts      env parsing with Zod (fails fast on missing secrets)
│  │  │  ├─ db/            drizzle schema.ts, client, migrations/, seed.ts
│  │  │  ├─ auth/          password.ts, session.ts, totp.ts, backupCodes.ts, routes.ts, guards.ts
│  │  │  ├─ content/       routes for modules/lessons/exercises/quizzes
│  │  │  ├─ progress/      progress + quiz grading
│  │  │  ├─ model/         provider.ts (interface), ollama.ts, fake.ts, agentLoop.ts, tools/, routes.ts
│  │  │  ├─ ops/           health.ts, metrics.ts, opsRoutes.ts
│  │  │  └─ plugins/       logging, rate-limit, csrf, error handler
│  │  └─ test/             integration tests (real Postgres)
│  └─ web/                 React SPA
│     └─ src/
│        ├─ routes/        one folder per route
│        ├─ components/    ui/, viz/ (Canvas/SVG components), trace/
│        ├─ features/      auth/, modules/, exercises/<kind>/, runs/
│        ├─ lib/api.ts     typed fetch client (uses packages/shared contracts)
│        └─ workers/       harnessRunner.worker.ts (Module 6)
├─ packages/
│  ├─ nn-core/             pure TS, zero deps: perceptron, mlp, autograd-lite, bpe, attention, pca, datasets
│  └─ shared/              Zod schemas + TS types for every API contract, tool schemas, exercise configs
├─ content/                authored curriculum, seeded into DB
│  └─ modules/<nn-slug>/module.json, lessons/*.md, exercises.json, quiz.json
├─ docker/                 Dockerfile (multi-stage), docker-compose.yml, observability/ (prometheus.yml, grafana/)
├─ docs/                   these design docs + runbooks/ + postmortems/
├─ .github/workflows/      ci.yml, deploy.yml, uptime.yml
├─ package.json, pnpm-workspace.yaml, tsconfig.base.json, .eslintrc, .prettierrc
```

## The `ModelProvider` boundary

This is the single most important seam in the codebase. Nothing outside `apps/api/src/model/` may import Ollama-specific code or know the port number.

```ts
// packages/shared/src/model.ts  (types only; implementation in apps/api/src/model)
type Role = 'system' | 'user' | 'assistant' | 'tool';

interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];      // on assistant messages
  toolName?: string;           // on tool messages
}

interface ToolDefinition {     // JSON-Schema function tool, provider-neutral
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

interface ToolCall {
  id: string;                  // provider may not supply; we mint one
  name: string;
  args: unknown;               // already parsed if provider parsed it
  rawArgs?: string;            // original text if we had to parse it ourselves
  parseOk: boolean;
}

interface ChatRequest {
  model?: string;              // default from config
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  format?: 'json' | JsonSchemaObject;   // structured output
  options?: { temperature?: number; topP?: number; maxTokens?: number; seed?: number };
}

interface ChatResponse {
  message: ChatMessage;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
  providerMeta?: Record<string, unknown>;   // raw timings etc., stored in agent_run_steps.raw
}

interface ModelProvider {
  readonly name: 'ollama' | 'fake' | 'none';
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  embed(texts: string[], model?: string): Promise<number[][]>;
  health(): Promise<{ ok: boolean; models: string[]; detail?: string }>;
}
```

Provider selection is by env: `MODEL_PROVIDER=ollama | fake | none`.
- `ollama`: `OLLAMA_BASE_URL` (default `http://localhost:11434`), `OLLAMA_CHAT_MODEL=gemma4:e4b`, `OLLAMA_EMBED_MODEL=nomic-embed-text`.
- `fake`: deterministic scripted responses keyed by a `scenario` hint in the system prompt or by request shape. Used by unit/integration/E2E tests and by CI. Includes scenarios for malformed tool-call JSON, a tool that doesn't exist, and a model that never stops calling tools (to exercise max-iteration handling).
- `none`: the deployed free-tier instance. `/model/*` routes return `503 { code: 'MODEL_UNAVAILABLE' }` and the UI shows "Run the app locally to use this exercise." Modules 1–3 are fully functional without a model (embeddings use a precomputed JSON fallback).

### Ollama specifics the provider must absorb
- `POST /api/chat` with `stream:false`, `tools:[{type:'function', function:{name,description,parameters}}]`, `format: <json schema object>` for structured output, `options:{temperature, num_predict, seed}`, `keep_alive:'10m'`.
- Response fields mapped: `message.content`, `message.tool_calls[].function.{name,arguments}`, `prompt_eval_count` → promptTokens, `eval_count` → completionTokens, `total_duration` (ns) → latencyMs.
- Tool results are sent back as `{ role:'tool', content: JSON.stringify(result), tool_name }`.
- **Parse-failure fallback:** if `tool_calls` is absent but `content` contains a fenced JSON block shaped like `{ "name": ..., "arguments": ... }`, extract it and mark `parseOk:false, recovered:true`. This is recorded as a metric (`tool_call_parse_failures_total{recovered="true"}`) and is one of the SRE signals the curriculum teaches about.
- Timeouts: per call 90 s (small local models on CPU are slow), abortable via `AbortSignal`.

## The agent loop (server-side, Module 5)

```
run = createRun(user, exercise, systemPrompt, tools, userPrompt, maxIterations)
messages = [system, user]
for i in 1..maxIterations:
    resp = provider.chat({messages, tools})            -> step(kind='model_call', latency, tokens)
    if resp.message.toolCalls is empty:
        finalize(run, resp.message.content)             -> step(kind='final'); status='completed'; return
    messages.push(resp.message)
    for call in resp.message.toolCalls:
        step(kind='tool_call', name, args, parseOk)
        if !parseOk or tool not in allowed set or args fail schema:
            result = { error: '...' }                   -> step(kind='tool_result', isError=true)
        else:
            result = await executeTool(call)            -> step(kind='tool_result', latency)
        messages.push({role:'tool', content: JSON.stringify(result), toolName})
status = 'max_iterations'; finalize with last assistant content (if any)
```
Guardrails: `maxIterations` default 8, hard cap 15; total run wall-clock 5 min; tool execution 10 s; run is persisted step-by-step so a crash mid-run leaves an inspectable partial trace (and `status='failed'`). Steps are pushed to the client over **Server-Sent Events** (`GET /model/runs/:id/events`) so the trace viewer animates live.

Tools are **never** learner-supplied code. The learner chooses from a server-side catalog (`calculator`, `get_current_time`, `unit_convert`, `lookup_glossary` (searches the app's own lesson content), `fake_weather`) and/or defines **mock tools**: a name, description, JSON-schema parameters, and a static or table-driven response. Mock tools are enough to teach tool schemas and traces without ever `eval`-ing anything on the server.

## Module 6 harness exercise: where the learner's loop runs

The learner writes `runAgent(model, tools, userMessage)` in JavaScript in a CodeMirror editor. It executes in a **Web Worker** in their own browser (no server-side eval). The worker is given:
- `model.chat(messages, toolDefs)` → `POST /api/v1/model/chat` with the current `run_id`, so every model call is logged as a step exactly like the server loop.
- `tools` → local JS implementations (calculator, time, glossary via API) that also report `tool_call`/`tool_result` steps via `POST /api/v1/model/runs/:id/steps`.
- A `scripted` flag that swaps `model.chat` for a deterministic in-worker fake so the three auto-checks (terminates with a final answer; appends tool results as `tool` messages; respects `maxIterations`) are reproducible even when Ollama is slow or absent.

## API design summary (REST, `/api/v1`, JSON, cookie session)

Full contract types live in `packages/shared`. Every route has a Zod request/response schema; the OpenAPI document is generated from them (`@fastify/swagger`) and served at `/api/docs` in dev.

### Auth
| Method | Path | Body → Response | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{email, password, displayName}` → `201 {user}` | Creates a full session (no MFA yet) |
| POST | `/auth/login` | `{email, password}` → `{status:'ok', user}` or `{status:'mfa_required'}` | Sets `sid` cookie either way; pending session if MFA |
| POST | `/auth/mfa/verify` | `{code}` (TOTP or backup code) → `{status:'ok', user, usedBackupCode?}` | Upgrades pending session |
| POST | `/auth/logout` | → `204` | Revokes session |
| GET | `/auth/me` | → `{user, session:{mfaVerified, expiresAt}}` | |
| POST | `/auth/mfa/enroll` | `{password}` → `{otpauthUri, qrSvg, secretForManualEntry}` | Requires fresh password |
| POST | `/auth/mfa/confirm` | `{code}` → `{backupCodes: string[10]}` | Enables MFA; codes shown once |
| POST | `/auth/mfa/backup-codes/regenerate` | `{password, code}` → `{backupCodes}` | |
| POST | `/auth/mfa/disable` | `{password, code}` → `204` | |
| PATCH | `/auth/password` | `{currentPassword, newPassword}` → `204` | Revokes other sessions |
| GET/DELETE | `/auth/sessions`, `/auth/sessions/:id` | list / revoke | Nice SRE tie-in: "where am I logged in" |

### Content (read-only for learners; content is seeded)
| GET `/modules` | list with per-user progress summary |
| GET `/modules/:slug` | module + ordered lessons + exercises + quiz summary (no questions) |
| GET `/lessons/:id` | lesson body (Markdown) |
| GET `/exercises/:id` | exercise kind + config |
| GET `/quizzes/:id` | questions **without** `correct` or `explanation` fields |

### Progress
| PUT `/progress/lessons/:id` | `{status}` |
| PUT `/progress/exercises/:id` | `{status, state?}` — `state` is the learner's saved work (jsonb, ≤ 64 KB) |
| GET `/progress` | full per-module summary (backed by a SQL view) |
| POST `/quizzes/:id/attempts` | `{answers:[{questionId, answer}]}` → graded attempt with per-question correctness + explanations |
| GET `/quizzes/:id/attempts` | history |

### Model
| POST `/model/chat` | `ChatRequest` + `{runId?, exerciseId?}` → `ChatResponse` — single call; logged as a run of kind `prompt`/`structured` if no `runId`, otherwise appended as a step |
| POST `/model/runs` | `{exerciseId, kind:'agent'|'harness', systemPrompt, tools, userPrompt, maxIterations?}` → `202 {runId}` — for `agent`, the server loop starts; for `harness`, just opens the run for the browser loop |
| POST `/model/runs/:id/steps` | client-reported steps (harness only) |
| POST | `/model/runs/:id/cancel` |
| GET `/model/runs/:id` | run + steps |
| GET `/model/runs/:id/events` | SSE stream of steps |
| GET `/model/runs` | my runs (paginated) |
| GET `/model/health` | provider status (public, used by UI banners) |

### Ops
| GET `/health` | `{status:'ok'|'degraded'|'down', checks:{db, model}}` — `degraded` when only the model is down, so uptime monitors don't page for a missing Ollama |
| GET `/metrics` | Prometheus text; protected by `METRICS_TOKEN` bearer |
| GET `/ops/sli` | last-24h SLIs computed from `agent_runs`/`agent_run_steps` (JSON) — powers the in-app `/ops` page |

### Conventions
- Errors: `{ error: { code: 'VALIDATION_FAILED' | 'UNAUTHENTICATED' | 'MFA_REQUIRED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'MODEL_UNAVAILABLE' | 'MODEL_TIMEOUT' | ..., message, details? } }` with matching HTTP status.
- Every response carries `x-request-id`; it is also in every log line.
- Pagination: `?cursor=&limit=` on list endpoints.
- State-changing requests must include header `X-Requested-With: fetch` (CSRF defense alongside `SameSite=Lax`); the API rejects otherwise.

## Frontend architecture

### Routes
```
/                         Dashboard: module cards with progress rings; model-availability banner
/login  /register         auth
/login/mfa                second factor step (only reachable with a pending session)
/settings/security        MFA enroll / backup codes / sessions list
/modules                  curriculum index
/modules/:slug            module overview (lessons, exercise, quiz, progress)
/modules/:slug/lessons/:lessonSlug
/modules/:slug/exercise   the module's interactive exercise (component chosen by exercise.kind)
/modules/:slug/quiz       quiz + results
/runs                     my agent runs
/runs/:id                 trace viewer (shared by Module 5, Module 6, and the SRE lesson)
/ops                      SLI dashboard (any logged-in user; it's a learning app)
```
Route guards: `<RequireAuth>` redirects to `/login`; if session is pending-MFA it redirects to `/login/mfa`.

### State
- **Server state:** TanStack Query. Query keys: `['me']`, `['modules']`, `['module', slug]`, `['lesson', id]`, `['quiz', id]`, `['progress']`, `['run', id]`. Mutations invalidate `['progress']` and `['modules']`.
- **Exercise playground state:** a Zustand store per exercise kind (e.g. `usePerceptronStore`: points, weights, lr, isTraining). Kept out of React state so the animation loop can mutate at 60 fps without re-rendering the whole tree.
- **Auth:** derived from `['me']`; no separate store.
- **Persistence:** exercise state is saved to `PUT /progress/exercises/:id` on a 2-second debounce.

### Visualization component pattern
Every visualization splits into three layers:
1. **Pure model** in `packages/nn-core` (e.g. `Mlp.forward(x)`, `Mlp.backward(y)`, `Mlp.step(lr)`), no DOM, fully unit-tested.
2. **Controller hook** in `apps/web/src/features/exercises/<kind>/use<Kind>.ts` that owns the Zustand store and a `requestAnimationFrame` loop (`useAnimationLoop(cb, running)`).
3. **Render components** that only read state and draw:
   - `PerceptronCanvas` (Canvas 2D: points, decision line, drag-to-add points)
   - `BoundaryHeatmap` (Canvas: evaluates the MLP on a grid; drawn with `putImageData`)
   - `NetworkGraph` (SVG: nodes = neurons with activation fill, edges = weights with stroke width ∝ |w| and colour by sign; hover shows value and current gradient)
   - `LossChart` (SVG polyline)
   - `TokenChips` (DOM spans, colour-cycled by token id) and `MergeTable`
   - `EmbeddingScatter` (SVG points after PCA; drag-select two words → cosine similarity)
   - `AttentionHeatmap` (SVG grid, colour scale) + `AttentionArcs` (SVG paths from query word to key words, opacity ∝ weight)
   - `AgentTrace` (DOM timeline: one card per step, colour by kind, expandable JSON, latency badges) reused by `/runs/:id`
   - `ToolSchemaBuilder` (form → JSON Schema) and `CodeEditor` (CodeMirror)

Canvas is used where there are many points or a per-pixel heatmap; SVG where elements are few and need hover/click semantics.

## Production topology
One Docker image: multi-stage build compiles `packages/*`, `apps/web` (Vite → static) and `apps/api`; the runtime stage runs `node apps/api/dist/server.js`, which serves `/api/*` and the SPA (with history fallback) on the same origin. Migrations run as a separate pre-deploy command (`pnpm --filter api migrate`), never at server start.

Locally: `docker compose up` gives Postgres (+ optional `--profile observability` for Prometheus/Grafana/Loki); the API and web run with hot reload on the host; Ollama runs natively on the host.
