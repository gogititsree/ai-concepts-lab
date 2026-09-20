# AI Concepts Lab — design docs

**The project is finished (M0–M15). Start with [HANDOFF.md](HANDOFF.md)** — it describes
the system as built, which is not in every respect the system these documents describe.
Read 01–07 in order the first time you need the design reasoning; afterwards jump to the
doc named by the thing you are changing.

| File | Contents |
|---|---|
| [01-architecture.md](01-architecture.md) | Stack decisions, repo layout, `ModelProvider` seam, agent loop, API design, frontend architecture, production topology |
| [02-schema.md](02-schema.md) | Full PostgreSQL schema: enums, tables, indexes, view, normalisation notes |
| [03-auth-mfa.md](03-auth-mfa.md) | Password hashing, sessions vs JWT decision, cookie/CSRF, TOTP + backup-code flows step by step, test vectors |
| [04-curriculum.md](04-curriculum.md) | All six modules: lessons, exercise/visualization spec, tasks, sample quiz questions, tests |
| [05-quality-and-ops.md](05-quality-and-ops.md) | Testing strategy, CI/CD workflows, secrets, metrics/SLOs/alerting/runbooks, the postmortem exercise |
| [06-roadmap.md](06-roadmap.md) | Milestones M0–M15, each self-contained with acceptance criteria — **and, now, a `Done` paragraph per milestone recording what actually happened** |
| [07-open-decisions.md](07-open-decisions.md) | Decisions left open, recommendations, deadlines by milestone, risks |
| [HANDOFF.md](HANDOFF.md) | **Read first.** The system as built: real stack, real test counts, the six ADRs, measured model behaviour, what is deployed (nothing) and the known gaps |

Supporting material:

| Folder / file | Contents |
|---|---|
| [adr/](adr/) | Six accepted ADRs — every place the code deviates from the documents above, and why |
| [runbooks/](runbooks/) | Eight runbooks, Symptoms → Diagnose → Mitigate → Verify → Follow-ups. Four were corrected by the M15 incidents |
| [postmortems/](postmortems/) | [`TEMPLATE.md`](postmortems/TEMPLATE.md) and the two blameless postmortems from the M15 break-it-on-purpose exercise |
| [slo.md](slo.md) | The four SLOs: what each is measured from, the error-budget policy, and what is deliberately not measured |
| [spike-notes.md](spike-notes.md) | Every real measurement against `gemma4:latest`, from M0 through M11 |
| [erd.md](erd.md) | Generated entity-relationship diagram |
| [github-setup.md](github-setup.md) | The one-time set-up nobody has run yet, and the reason two incidents happened |
