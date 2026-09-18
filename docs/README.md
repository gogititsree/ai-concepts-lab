# AI Concepts Lab — design docs

Read in order the first time; afterwards jump to the doc named by the milestone you are working on.

| File | Contents |
|---|---|
| [01-architecture.md](01-architecture.md) | Stack decisions, repo layout, `ModelProvider` seam, agent loop, API design, frontend architecture, production topology |
| [02-schema.md](02-schema.md) | Full PostgreSQL schema: enums, tables, indexes, view, normalisation notes |
| [03-auth-mfa.md](03-auth-mfa.md) | Password hashing, sessions vs JWT decision, cookie/CSRF, TOTP + backup-code flows step by step, test vectors |
| [04-curriculum.md](04-curriculum.md) | All six modules: lessons, exercise/visualization spec, tasks, sample quiz questions, tests |
| [05-quality-and-ops.md](05-quality-and-ops.md) | Testing strategy, CI/CD workflows, secrets, metrics/SLOs/alerting/runbooks, the postmortem exercise |
| [06-roadmap.md](06-roadmap.md) | Milestones M0–M15, each self-contained with acceptance criteria |
| [07-open-decisions.md](07-open-decisions.md) | Decisions left open, recommendations, deadlines by milestone, risks |
| [HANDOFF.md](HANDOFF.md) | Condensed brief to paste into an implementation session |

Later folders: `adr/` (deviations from these docs), `runbooks/`, `postmortems/`, `spike-notes.md`, `slo.md`, `erd.md`.
