# Working on this repo

A solo learning project, so "contributing" mostly means "future you". The workflow below
exists because practising it is part of the point, not because the repo needs ceremony.

## Setup

```bash
pnpm install
pnpm setup:env     # writes .env with freshly generated secrets
pnpm db:up         # Postgres in Docker
pnpm db:migrate
pnpm db:seed
pnpm dev           # API on :3000, web on :5173
```

Modules 4 to 6 additionally need [Ollama](https://ollama.com) running locally:

```bash
ollama pull gemma4:latest
ollama pull nomic-embed-text
```

Without it the app still runs; those modules show a banner explaining why the exercises are
inert. Modules 1 to 3 never need a model.

## One branch per milestone

```bash
git switch -c m13-production-hardening
# ...work...
pnpm verify                      # everything CI will run
git push -u origin HEAD
gh pr create --fill
```

`main` is protected once [docs/github-setup.md](docs/github-setup.md) has been followed, so
this is the only way in. Merge with a merge commit so each milestone stays legible in the
history.

## What has to be green

| Command                              | What it covers                                           |
| ------------------------------------ | -------------------------------------------------------- |
| `pnpm lint`                          | ESLint over apps and packages                            |
| `pnpm format:check`                  | Prettier                                                 |
| `pnpm typecheck`                     | `tsc` across all four workspaces                         |
| `pnpm test`                          | unit tests (nn-core, shared, api, web)                   |
| `pnpm --filter api test:integration` | API against a real Postgres                              |
| `pnpm test:e2e`                      | one Playwright journey against the built app             |
| `pnpm test:coverage:gate`            | 90% lines on `nn-core` and api `auth`/`model`/`progress` |

The end-to-end and integration suites both need `pnpm db:up` first.

## House rules

These come from `CLAUDE.md` and are worth restating:

- **The design docs are the specification.** `docs/01`–`07` were written before the code. If
  reality has to diverge, write an ADR in `docs/adr/` rather than editing the design doc and
  pretending it was always so. There are four so far, and two of them record genuine bugs in
  the original design.
- **Nothing outside `apps/api/src/model/` may mention Ollama.** Everything goes through the
  `ModelProvider` interface. That is what lets the whole test suite run without a model.
- **`MODEL_PROVIDER=fake` in every test.** No test may call a real model: it would be slow,
  non-deterministic, and would fail in CI where no model exists.
- **Don't add a dependency without asking.** The stack is listed in `docs/01-architecture.md`.
  CodeMirror is the standing example: the harness editor is a textarea because adding it was
  not approved.
- **Explain the non-obvious in comments and PR descriptions.** The point of this repo is
  understanding, not throughput. A comment saying _why_ is worth more than one saying _what_.

## Where things live

```
apps/api      Fastify: auth, content, progress, model. Drizzle schema and migrations.
apps/web      React SPA: routes, exercises, visualizations.
packages/nn-core   From-scratch ML maths. Zero dependencies. Runs in the browser and in tests.
packages/shared    Zod contracts shared by both sides.
content/      The curriculum as Markdown and JSON, seeded into Postgres.
e2e/          The one Playwright journey.
docs/         Design docs, ADRs, runbooks, spike measurements.
```

A useful habit when picking something up again: read `docs/06-roadmap.md` for the milestone,
then the design doc it names, before opening any code.
