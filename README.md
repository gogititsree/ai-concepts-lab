# AI Concepts Lab

An interactive web app that teaches AI/ML concepts (neurons -> neural nets -> LLM internals ->
prompting -> agents -> harnesses) and is also the vehicle for learning the full SDLC.

Design docs live in [`docs/`](docs/); start with [`docs/HANDOFF.md`](docs/HANDOFF.md) and
[`docs/06-roadmap.md`](docs/06-roadmap.md). This README describes what exists **today**
(milestone M1: the hello-world skeleton — one health endpoint, one page that renders it).

## Prerequisites

| Tool           | Version                 | Notes                                           |
| -------------- | ----------------------- | ----------------------------------------------- |
| Node.js        | >= 22 (developed on 24) | `engines` in the root `package.json`            |
| pnpm           | 11.5.0                  | pinned via `packageManager`; `corepack enable`  |
| Docker Desktop | any current version     | for the production image and, from M4, Postgres |

## Setup

```bash
corepack enable          # makes the pinned pnpm available
pnpm install
cp .env.example .env     # every value already has a working default
pnpm build               # compiles packages/* so the apps can be type-checked
```

## Running it

```bash
pnpm dev
```

This starts both apps in parallel:

- API on <http://localhost:3000> (`tsx watch`, pretty pino logs)
- Web on <http://localhost:5173> (Vite)

The Vite dev server proxies `/api` to the API, so the browser only ever talks to one origin —
the same arrangement as production, where the API serves the built SPA itself. Open
<http://localhost:5173> and the page shows the `status` and `version` it read from
`GET /api/v1/health`.

## Scripts

| Script               | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `pnpm dev`           | API + web in watch mode                                            |
| `pnpm build`         | Builds every workspace package in dependency order                 |
| `pnpm lint`          | ESLint 9 (flat config) over the whole repo                         |
| `pnpm format`        | Prettier, writing changes                                          |
| `pnpm format:check`  | Prettier in check mode (what CI runs)                              |
| `pnpm typecheck`     | `tsc --noEmit` per package                                         |
| `pnpm test`          | Vitest in every package                                            |
| `pnpm test:unit`     | Same, kept separate so later milestones can add `test:integration` |
| `pnpm test:coverage` | Vitest with V8 coverage (uploaded as a CI artifact)                |

Note: `packages/*` are consumed by the apps as compiled `.d.ts`, so run `pnpm build` once
before `pnpm typecheck` on a fresh clone. (`pnpm test` needs no build: the Vitest configs
alias `@lab/shared` to its source.)

## Layout

```
apps/
  api/    Fastify 5 + Zod type provider; serves the SPA in production
  web/    React 19 + Vite 6 + Tailwind 4 + React Router 7
packages/
  shared/   Zod contracts shared by API and web (HealthResponseSchema today)
  nn-core/  from-scratch ML math, zero runtime deps (filled in by M2)
docker/   Dockerfile (multi-stage, one image) and docker-compose.yml (Postgres)
docs/     design docs, roadmap, spike notes
spike/    M0 Ollama spike scripts
```

## Environment

All of it is optional in development — see [`.env.example`](.env.example). `apps/api/src/config.ts`
parses the environment with Zod at startup and exits with a readable error if anything is wrong.

| Variable    | Default       | Meaning                                                |
| ----------- | ------------- | ------------------------------------------------------ |
| `NODE_ENV`  | `development` | `production` turns on SPA serving and JSON logs        |
| `PORT`      | `3000`        | API listen port                                        |
| `HOST`      | `0.0.0.0`     | listen address (`0.0.0.0` so containers are reachable) |
| `GIT_SHA`   | `dev`         | reported as `version` by `/api/v1/health`              |
| `LOG_LEVEL` | `info`        | pino level                                             |

## API

| Method | Path             | Response                                                    |
| ------ | ---------------- | ----------------------------------------------------------- |
| GET    | `/api/v1/health` | `{ status: 'ok' \| 'degraded' \| 'down', version, checks }` |

Every response carries an `x-request-id` header. `checks` is empty until M4 (database) and
M9 (model provider) add entries to it.

## Docker

```bash
docker build -f docker/Dockerfile -t ai-concepts-lab:dev --build-arg GIT_SHA=$(git rev-parse HEAD) .
docker run --rm -p 3100:3000 --name lab-smoke ai-concepts-lab:dev
curl http://localhost:3100/api/v1/health
open http://localhost:3100/          # the SPA, served by the API
```

The image is multi-stage (install -> build -> prune dev deps -> copy into a clean
`node:24-alpine`), runs as the non-root `node` user, exposes 3000 and has a `HEALTHCHECK`
hitting `/api/v1/health`.

Postgres is not used yet, but the compose file is in place:

```bash
docker compose -f docker/docker-compose.yml up -d postgres
```

## CI/CD

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — on every PR and push to `main`:
  `lint` (lint + format check + typecheck), `unit` (tests + coverage artifact), then
  `build-image` which builds the Docker image and, outside pull requests, pushes it to
  `ghcr.io/<owner>/<repo>` tagged with the commit sha (plus `main` on the default branch).
- [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) — after CI succeeds on `main`
  (or manually): POSTs the Render deploy hook, then polls `/api/v1/health` for up to five
  minutes until `version` equals the deployed commit, and finally smoke-checks the API and
  the SPA.

### Render setup (manual, one time)

1. Create a **Web Service** from this repository using [`render.yaml`](render.yaml)
   (Docker runtime, free plan, health check path `/api/v1/health`, auto-deploy off).
2. Copy the service's **deploy hook URL** into the repository secret `RENDER_DEPLOY_HOOK_URL`.
3. Set the repository variable `APP_URL` to the public URL, e.g. `https://ai-concepts-lab.onrender.com`.

`GIT_SHA` is `sync: false` in the blueprint. When Render builds the image itself there is no
build arg, so the API falls back to Render's own `RENDER_GIT_COMMIT` variable — which is what
makes the deploy workflow's version poll meaningful.

## Conventions

- TypeScript strict everywhere; one Zod schema per contract, shared by both sides of the wire.
- Work on `mNN-<slug>` branches, PR into `main`, squash-merge. Deviations from `docs/` need an
  ADR in `docs/adr/`.
