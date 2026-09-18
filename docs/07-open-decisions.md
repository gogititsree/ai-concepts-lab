# 07 — Open decisions and tradeoffs

Decisions already made are in 01–06. These are the ones deliberately left to you, with a recommendation and the point in the roadmap by which they must be settled.

| # | Decision | Options | Recommendation | Decide by |
|---|---|---|---|---|
| 1 | **How the deployed app reaches a model** | (a) `MODEL_PROVIDER=none` in prod; modules 4–6 are "run locally" only. (b) Cloudflare Tunnel from your laptop exposing Ollama with a shared-secret header; prod uses `OLLAMA_BASE_URL=https://<tunnel>`. (c) Add a cloud provider later. | **(a) now**, (b) as a stretch after M13, (c) only if you want to learn cost controls. (a) is honest about the constraint and gives you graceful degradation for free. | M9 |
| 2 | **Hosting** | Render free web + Neon free Postgres (recommended) vs Fly.io (needs a card; more control, Postgres on a VM you manage) vs Railway (trial credits expire). | **Render + Neon.** Free service sleeps after inactivity: first request takes ~30–60 s. Acceptable for a learning app; it's also a realistic cold-start lesson. If you already have a card on Fly and prefer VM-level control, Fly is fine and `deploy.yml` changes to `flyctl deploy`. | M1 |
| 3 | **Backend framework** | Fastify (chosen) vs Express. | Keep Fastify. Switch only if you find tutorial scarcity is slowing you more than validation-by-hand would. | M1 |
| 4 | **Harness exercise runtime** | Learner code in a Web Worker (chosen) vs editing the real server loop in the repo. | Worker for the in-app exercise; you will *also* write the real loop yourself in M10, so both happen. | M11 |
| 5 | **Content editing** | Repo files → seed (chosen) vs admin UI. | Files. An admin UI is scope creep for a solo learner. | M4 |
| 6 | **Email flows** | Skip verification/reset (chosen for now) vs add with Resend/Mailgun free tier. | Skip until after M15; add as a backlog milestone — it's a good "integrate a third-party API with retries" lesson later. | Backlog |
| 7 | **Embedding model** | `nomic-embed-text` (small, fast) vs using `gemma4:e4b` embeddings if Ollama exposes them for that model. | `nomic-embed-text`; the exercise is about intuition, not model quality. | M8 |
| 8 | **Real tokenizer comparison** | From-scratch BPE only (chosen) vs also bundling `gpt-tokenizer` (~1 MB) for a "real model" side-by-side. | Start without; add if the tokenizer tab feels toy-only. | M8 |
| 9 | **Rate-limit store** | In-memory (chosen; single instance) vs Postgres-backed. | In-memory. Upgrade if you ever run two instances; note it in the runbook. | M5 |
| 10 | **Integration test DB** | Testcontainers (needs Docker in CI; GitHub runners have it) vs compose service container. | Service container in CI, Testcontainers locally if convenient. Both are documented in 05. | M4 |
| 11 | **Gemma 4 tool-calling reliability** | If M0 shows tool calls arrive as text/malformed often: keep native tools + the fenced-JSON recovery (chosen), or fall back to a pure "prompt-based JSON tool protocol". | Native + recovery. The recovery path is itself a lesson and a metric. If reliability is < ~70 % on the calculator test, switch the provider to prompt-based JSON for tool calls behind the same interface. | M0/M9 |
| 12 | **Registration enumeration** | Simple 409 on existing email (chosen) vs non-revealing response. | Simple; documented as a conscious tradeoff for a solo app. | M5 |
| 13 | **Where housekeeping runs** | In-process `setInterval` vs external schedule (Render cron / GitHub Actions). | In-process for local; GitHub Actions schedule hitting an authenticated maintenance endpoint in prod (free, visible). | M13 |
| 14 | **Styling** | Tailwind (chosen) vs CSS modules. | Tailwind. | M3 |
| 15 | **Module gating** | All modules open with progress shown (chosen) vs locking modules until the previous quiz passes. | Open. Gating adds friction for a solo learner and complicates tests. | M7 |
| 16 | **Structured-output reliability and thinking output** (from M0: `format`=JSON schema succeeded only 3/5; `message.thinking` present on most responses and dominates latency) | (a) Send `think: false` on every request except where the lesson wants to show reasoning; on structured-output validation failure retry once with the Zod error appended, then surface `STRUCTURED_OUTPUT_INVALID`. (b) Accept flakiness and teach it. | **(a)**, and make the retry count a metric (`structured_output_retries_total`). Re-measure reliability with `think:false` in M9 before designing Module 4 tasks. | M9 |

## Findings from M0 (2026-09-17)
- Installed model is `gemma4:latest` (8B Q4_K_M), not `e4b`; all docs and env defaults use `gemma4:latest`.
- Tool calling: 5/5 native `tool_calls`, `function.arguments` arrives as a parsed object (adapter must still handle string).
- Structured output: 3/5 valid; see decision 16.
- Latency 10–45 s warm, 19–37 s cold load; `message.thinking` is the main cost. `prompt_eval_cached_count` is present and should go to `providerMeta`.
- Details: docs/spike-notes.md, fixtures in apps/api/test/fixtures/ollama/.

## Risks to keep an eye on
- **Local inference speed** on a CPU-only machine may make Module 5/6 runs take a minute each. Mitigations are in the `slow-inference` runbook; the scripted fake keeps the exercises completable.
- **Ollama API drift** (field names, `format` semantics). All Ollama specifics are in one file; M0 fixtures pin the current shape.
- **Render cold starts** may make the E2E-style smoke test in `deploy.yml` flaky; the poll has a 5-minute budget.
- **Scope creep** in visualizations. Each viz has a "done" definition in 04-curriculum.md; polish beyond it goes to the backlog.
