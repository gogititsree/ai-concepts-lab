# Postmortem — a one-step column rename broke every agent-run route while `/health` reported `ok`

- **Date:** 2026-09-20
- **Authors:** the one person who works on this (M15, the deliberate "break something" exercise)
- **Status:** final

> **This incident was staged on purpose.** It is the primary scenario in
> `docs/05-quality-and-ops.md` → "The deliberate break something postmortem exercise",
> run for real against the real stack: Postgres 16 in Docker, the built `apps/api/dist`
> started in `NODE_ENV=production` serving the built SPA, a seeded database, and
> `MODEL_PROVIDER=ollama` against `gemma4:latest`. Every timestamp and every error string
> below was observed, not imagined.
>
> **It was staged locally, because there is nothing else to stage it on.** This repository
> has no git remote, no GitHub Actions have ever executed, and no Render service exists
> (`docs/adr/0004` § 5, and its addendum). Where that changes a conclusion — and it
> changes two of them badly — it is called out inline rather than smoothed over.

## Summary

A migration that renamed `agent_runs.final_output` to `output` was deployed together with
application code that still declared the old name, and from the moment the pre-deploy
migration committed, every route that touches `agent_runs` answered HTTP 500 with
`PostgresError: column "final_output" does not exist`. `GET /health` reported `ok`
throughout, the deploy pipeline's post-deploy smoke check passed against the broken
deployment, and no alert fired.

## Impact

**Who:** every learner using modules 4, 5 and 6 — which on this project is one person, so
the real-world impact was zero. Read the rest as "what this would have cost", not as "what
it cost".

**What:** the entire `agent_runs` surface was unavailable.

| Route | Before | During |
| --- | --- | --- |
| `GET /api/v1/health` | 200 `ok` | **200 `ok`** |
| `GET /api/v1/modules`, `/auth/me`, the SPA | 200 | 200 |
| `GET /api/v1/model/health` | 200 `ok` | 200 `ok` |
| `POST /api/v1/model/runs` | 202 | **500 `INTERNAL_ERROR`** |
| `GET /api/v1/model/runs` (list) | 200 | **500 `INTERNAL_ERROR`** |
| `GET /api/v1/model/runs/:id` (detail) | 200 | **500 `INTERNAL_ERROR`** |
| `GET /api/v1/ops/sli` | 200 | 200 |

Modules 1–3 (all the from-scratch maths, the tokenizer, the attention viewer) were
completely unaffected, because they never touch that table.

**How long:** 3 minutes 15 seconds from the migration committing (02:18:26Z) to the
mitigation (02:21:41Z), and 4 minutes 3 seconds to the permanent fix being live
(02:22:29Z). That number is meaningless as an MTTR and is reported only for completeness:
the operator was standing over the keyboard with the runbook already open, because the
operator caused it. **The honest impact duration is "until a human next opened
`/runs`", which for a solo learner is hours to days** — see Detection.

## Detection

**How it was found:** by looking. The operator opened the run list and the run detail
page, because the operator had just deployed the change. Nothing told anyone.

**How long after the start:** one second, for the same reason. In a real deployment the
answer is "whenever somebody next used modules 4–6", and nothing in the system shortens
that.

### What should have caught it, and did not

| Monitor | Verdict | Why |
| --- | --- | --- |
| `GET /health` | **Silent** | Reported `{"status":"ok","checks":{"db":{"ok":true}}}` for the whole incident. The probe is `SELECT 1`. The database was perfectly reachable; it was the *columns* that had moved. **A connectivity check is not a correctness check** — this is the lesson `docs/05` predicted, and it is exactly what happened. |
| `deploy.yml` → post-deploy smoke check | **Silent — verified** | The step was run verbatim against the broken deployment at 02:20:20Z and printed `SMOKE CHECK PASSED`. All five assertions (health + commit sha, `/modules` → 401, `/model/health`, the SPA shell and its JS bundle, the security headers) were still true. None of them touches a run. |
| UptimeRobot (5 min) | **Silent** | Same `/health` body. `ok` is `ok`. |
| `.github/workflows/uptime.yml` → health half | **Silent** | `down=false`, because the status was `ok`. No issue filed. |
| `.github/workflows/uptime.yml` → SLI half | **Worse than silent** | Two ways. (1) It read `successRate=0.6667` over 69 terminal runs both *before* and *after* the migration — the breach condition was already true for unrelated historical reasons, so the issue it would have opened says "Agent run success rate below 80 %" and points at the wrong runbook. (2) The incident **broke run creation**, so the trace table stopped growing; as the 24-hour window rolled forward, `terminal` would fall below the check's floor of 10 and the check would go **quiet**. *The failure suppresses the only signal that could have found it.* |
| Grafana alert rules | **Silent** | All five rules (`rules.yml`) watch the model provider and the agent loop: p95 latency, model error rate, parse-failure rate, bad-outcome share, `model_provider_up`. **There is no rule on HTTP 5xx.** |
| Prometheus | **Had the answer, nobody asked** | `http_request_duration_seconds_count{route="/api/v1/model/runs/:id",method="GET",status="500"} 1` was scraped and stored. The series existed. Nothing alerts on it and no dashboard panel shows it. |
| pino → Loki | **Had the answer, nobody asked** | Three `level:50` lines with the full failing SQL and `caused by: PostgresError: column "final_output" does not exist`. Loki was running and ingesting them. There is no log-based alert. |
| CI (`pnpm verify`, the integration suite) | **Would have caught it in 49 seconds** | Run deliberately at 02:20:31Z against the broken tree: **30 failed, 111 passed, 23 skipped, across 4 failed files.** Postgres `code: '42703'`, `routine: 'checkInsertTargets'`. See Root causes → process for why that did not help. |

**Realistic time to detection, as the system stood: unbounded.** Nothing in the monitoring
stack distinguishes "the app is fine" from "every write path on the main feature table is
dead". The only detector was a human using the product.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| 02:14:21 | `pnpm db:up`. Postgres 16 healthy. |
| 02:14:44–02:14:54 | `pnpm db:migrate` (0000, 0001) and `pnpm db:seed`. 6 modules, 0 changed. |
| 02:15:29 | API started from the built `dist`, `NODE_ENV=production`, `GIT_SHA=m15-incident`. `/health` → `ok`. |
| 02:15:59–02:17:04 | Baseline: a real agent run against `gemma4:latest` (`2d26f145`) completes in 65 s, 2 iterations, final output "The amount compounded is approximately **4295.47**." |
| 02:17:13 | Baseline probe. `/health`, run list, run detail, `/ops/sli` — all 200. |
| 02:17:23 | **Control experiment.** The rename staged exactly as `docs/05` writes it: column renamed in the migration *and* in `schema.ts`, one reader left behind. |
| 02:17:33 | `tsc` fails in 10 s with three errors — `runs.ts:197` and `runs.ts:424` (the writers) and `runs.ts:248` (`toRunSummary`, the reader). **The literal scenario cannot be shipped from this codebase.** Reverted; see Root causes. |
| 02:18:01 | The compiler-clean staging typechecks clean: `schema.ts` declares *both* `final_output` and `output`, `RunRecorder.finish` and `markCompleted` write `output`, `toRunSummary` still reads `finalOutput`. This is a change that would pass review. |
| **02:18:26** | **Impact starts.** Pre-deploy migration `0002_rename_final_output.sql` applied: `ALTER TABLE agent_runs RENAME COLUMN final_output TO output`. Exit 0. |
| 02:18:27 | The **old** instance is still serving, as it would be during a Render deploy. `/health` → 200 `ok`. Run list → **500**. Run detail → **500**. `/ops/sli` → 200. This is the runbook's "you cannot just redeploy the old image", observed. |
| 02:19:30 | New instance live, `GIT_SHA=m15-incident-1`, `/health` → `ok`. A deploy would now be considered successful. |
| 02:19:38–02:19:49 | Full probe of the new instance. `/health`, `/auth/me`, `/modules`, `/model/health` → 200. `POST /model/runs` → **500**. Run list → **500**. Run detail → **500**. `/ops/sli` → 200. |
| 02:20:20 | `deploy.yml`'s post-deploy smoke check, run verbatim: **`SMOKE CHECK PASSED`**. |
| 02:20:31–02:21:23 | The integration suite, run for evidence: 30 failures in 49 s. |
| 02:21:41 | **Mitigation.** Forward-fix migration `0003`: `ALTER TABLE agent_runs ADD COLUMN final_output text GENERATED ALWAYS AS (output) STORED`. No redeploy. Run list and run detail return 200 **in the same second**; `POST /model/runs` accepted. |
| 02:22:08 | A full agent run completes through the mitigation: written to `output`, read back through the generated `final_output`. `psql` confirms both columns hold `5 plus 6 is 11.` |
| 02:22:29 | **Permanent fix.** Migration `0004` drops the generated column and renames `output` back to `final_output`; the code change is reverted to the single canonical name. |
| 02:22:50 | New instance `m15-fixed`. All four probes 200. The pre-incident run's `finalOutput` is intact — **no data was lost at any point**. |
| 02:22:50 | **Incident closed.** |

## Root causes

**Technical.** `agent_runs.final_output` was renamed to `output` by a migration that ran in
the same deploy as code which still declared `final_output` in `apps/api/src/db/schema.ts`.
Drizzle enumerates a table's declared columns explicitly in every statement it builds, so a
single missing column breaks every statement against that table, not just the one that
reads it:

```
Failed query: select "id", "user_id", …, "final_output", "error_code", … from "agent_runs"
  where ("agent_runs"."id" = $1 and "agent_runs"."user_id" = $2) limit $3
caused by: PostgresError: column "final_output" does not exist
    at async loadRun (…/apps/api/dist/model/runs.js:181:19)
```

```
Failed query: insert into "agent_runs" (…, "final_output", "output", …) values (…) returning "id"
caused by: PostgresError: column "final_output" of relation "agent_runs" does not exist
  severity: ERROR, code: 42703, routine: checkInsertTargets
```

**Process — and this is the part that generalises.** Three separate guards already existed
and every one of them was bypassed, each for a different reason:

1. **The type system caught the obvious version of this mistake, so the mistake had to be
   made in a less obvious way.** `tsc` rejects the rename `docs/05` describes, in ten
   seconds, at three call sites. The version that shipped survived compilation only because
   the table declared *both* names — the shape of a change a reviewer reads as "adding the
   new column first, tidy up later", which is to say it looks like *good* practice. The
   compiler is a real guard; what it cannot see is that `schema.ts` and the database are
   two separate sources of truth and nothing compares them.
2. **The integration suite catches it in 49 seconds, and has never run on anything but a
   laptop.** This repository has no remote; `ci.yml` has never executed. ADR 0004's
   addendum already recorded the general form of this — "the guard already existed and had
   never executed… that is the honest cost of deferring `docs/github-setup.md`". This
   incident is the second instance of the same root cause. **A guard that does not run is
   not a guard, and this project now has two documented cases.**
3. **The deploy pipeline had no way to notice**, and its own comments explain why: run
   creation needs a session, and the deployed instance runs `MODEL_PROVIDER=none` by
   design, so an authenticated synthetic run is both expensive and impossible. That
   reasoning was correct. The conclusion drawn from it — "so there is no run check" — left
   the gap that this incident walked through.

Underneath all three: **a schema change and the code that depends on it shipped in the same
deploy.** `docs/runbooks/db-migration-failed.md` already describes the expand/contract
discipline that prevents this in three deploys. It was not followed, deliberately, which is
the point of the exercise — but the system had no way to notice that it had not been.

## Contributing factors

- **`/ops/sli` kept working**, because its aggregation is `select * from agent_runs` inside
  a CTE and never names a column. That is good engineering (one round trip, one statement)
  and it had an unwanted consequence: the in-app dashboard showed a healthy-looking
  24-hour history for the entire outage, including a success rate computed over runs that
  no longer had any successors.
- **The two most specific error messages in the incident were in places nobody looks.**
  The `PostgresError` naming the exact column was in the pino log; the HTTP 500 counter was
  in Prometheus. Both were correct, both were ignored, because nothing routes either to a
  human.
- **`docs/05` predicted "creating runs works"**, which primed the expectation that the
  blast radius was one page. It was the whole table. A mental model of the failure that is
  narrower than the failure makes triage slower.
- **The error body is `INTERNAL_ERROR`** while `docs/runbooks/db-migration-failed.md` says
  to look for `INTERNAL` in the body. Small, but it is the kind of thing that costs a
  minute at 2am.

## What went well

- **`agent_run_steps` never broke**, so partial traces survived. Nothing about the trace
  store was lost.
- **No data was lost, at any point.** `RENAME COLUMN` preserves the data; the pre-incident
  run's final output was readable again the moment the column name was restored. This is
  the difference between a rename and a drop, and it is why the forward fix could be
  casual about ordering.
- **The runbook was right and was usable under pressure.** `docs/runbooks/db-migration-failed.md`
  diagnoses the case correctly from one `curl` ("`version` is the new commit and `status`
  is `ok` but routes are 500ing"), tells you not to redeploy the old image and explains
  why, and its "Mitigate → the migration succeeded and broke the app" section names both
  options that were actually used. It was written in M13 for this exact incident and it
  earned its keep.
- **The generated-column mitigation restored service in one second with no deploy.**
  `ADD COLUMN final_output text GENERATED ALWAYS AS (output) STORED` satisfied the reader
  and the writer simultaneously, and Postgres accepts `DEFAULT` for a generated column in
  an `INSERT`, so drizzle's insert — which names the column — kept working. Worth
  remembering: this is a genuine zero-downtime escape hatch for a rename gone wrong.
- **Errors were errors.** Every failure was a loud 500 with a precise Postgres message and
  a stack trace naming the function. Nothing failed silently or wrote wrong data.

## What went poorly

- **`/health` said `ok` for the entire outage.** The endpoint that the deploy gate, the
  external uptime monitor and the scheduled check all depend on was green while the
  application could not serve its main feature.
- **The post-deploy smoke check passed.** It is the one thing standing between a bad
  deploy and production, and it was verified to pass against this one.
- **Every alerting path was silent, and one of them was silent in a way that gets worse
  over time** (the SLI check going quiet as the broken window drains).
- **The signals that existed were not connected to anything.** Prometheus recorded the
  500s; Loki recorded the Postgres error. Neither is on a dashboard panel or an alert rule.
- **The whole exercise is only possible because CI has never run.** That is a finding about
  the project, not about the migration.

## Where we got lucky

- **The migration was a `RENAME`, not a `DROP`.** A dropped column would have been a data
  incident, and `docs/runbooks/db-migration-failed.md` is explicit that a down-migration
  recreates the column *empty*. Recovery would have meant a Neon point-in-time branch
  rather than one `ALTER TABLE`, and the 3-minute mitigation would have been an hour.
- **The failure was loud.** `docs/runbooks/db-migration-failed.md` warns about the quiet
  variant — an old instance whose `INSERT` "may still succeed while silently writing
  nothing, which is worse than an error because it is quiet". Drizzle's explicit column
  lists made that impossible here, by accident of the ORM rather than by design.
- **There are no users.** The impact table above is hypothetical. If this app had traffic,
  the detection gap would have been measured in however long it took a stranger to
  complain.
- **`/ops/sli` did not break.** If it had, the `uptime.yml` SLI half would have errored and
  might — by accident, for the wrong reason — have filed an incident. The right answer was
  reached for reasons that had nothing to do with this failure.

## Action items

| # | Action | Type | Owner | Due | Status |
| - | ------ | ---- | ----- | --- | ------ |
| 1 | **Boot-time and per-request schema assertion.** Compare drizzle's declared columns with `information_schema.columns`; a missing column makes `GET /health` report `down` and logs the list at boot. | prevent / detect | learner | 2026-09-20 | **done** |
| 2 | **Assert `checks.schema.ok` in `deploy.yml`'s post-deploy smoke check**, printing the detail string so the failure names the columns. | detect | learner | 2026-09-20 | **done** |
| 3 | **Regression tests**: unit tests for the `down` mapping and the cache, integration tests that perform this exact rename and assert the check fires — and that an *extra* database column does **not** fire it. | prevent | learner | 2026-09-20 | **done** |
| 4 | **Push this repository to GitHub and enable the workflows** (`docs/github-setup.md` is already written). Two incidents now have "the guard exists and has never run" as a root cause. | prevent | learner | next session | **open — the single highest-value item in this document** |
| 5 | A Grafana alert rule on the 5xx rate from `http_request_duration_seconds`, with a runbook entry. The series already exists; the rule does not. | detect | learner | backlog | open |
| 6 | Give `uptime.yml`'s SLI half a "no runs at all in the window" condition, so a trace table that has stopped growing is distinguishable from a quiet day only if the app *claims* to be in use. Low confidence that this can be made non-noisy for a solo learner — may be closed as "accepted". | detect | learner | backlog | open |
| 7 | Fix `docs/runbooks/db-migration-failed.md`: the error body code is `INTERNAL_ERROR`, not `INTERNAL`. | mitigate | learner | 2026-09-20 | **done** |

### Considered and not done

- **An authenticated synthetic run in `deploy.yml`.** Rejected, and the reasoning in the
  workflow's own comment stands: it needs a real account's password and TOTP seed in CI
  secrets, it writes rows into the production database on every deploy, and the deployed
  instance runs `MODEL_PROVIDER=none` so `POST /model/runs` answers 503 by design. It would
  cost two secrets and a growing table to assert something the schema check asserts for
  free. Revisit only if the deployment ever gets a model.
- **Making the app refuse to boot on schema drift.** Considered and rejected in favour of
  `/health` reporting `down`. An instance that exits answers nothing, and "no response" is
  the least diagnosable failure there is; `down` plus a list of missing columns is strictly
  more informative and stops the deploy just as effectively, because `deploy.yml` will not
  finish unless `/health` is `ok` or `degraded`.
- **Comparing column types, nullability and defaults as well as presence.** Rejected: they
  legitimately differ (a default added by a migration ahead of the code, a `citext` column
  drizzle models as `text`), and a check that produces false alarms is a check that gets
  turned off. Column presence is what turns into a 500.
- **Treating an extra database column as drift.** Actively wrong, and worth stating as a
  rejected option rather than leaving implicit: an extra column is the *expand* phase of
  expand/contract. A check that flagged it would forbid the exact discipline that prevents
  this incident. There is an integration test pinning this.
- **Reverting `0002` by editing it.** Never. Forward-only is the policy
  (`docs/runbooks/db-migration-failed.md`), and the recovery followed it: the fix was
  migrations `0003` and `0004`, not an edit.

### A note on what is in the repository now

The three incident migrations (`0002` rename, `0003` generated-column mitigation, `0004`
forward fix) were applied to a real database and then **removed from the repository**, and
the lab database was recreated from scratch, because they document a fault that was
manufactured for a teaching exercise and every future developer would have to read three
migrations to learn that nothing happened. They are quoted in full above.

**In production you could not do this, and that asymmetry is the lesson.** Once `0002` had
run anywhere real, it would be immutable forever and the history would carry all three
files permanently. Deleting them here is a privilege of the incident being fake.

## Verification that the fix works

The incident was re-staged against the new check at 02:41:08Z, by applying the same
`ALTER TABLE agent_runs RENAME COLUMN final_output TO output` to the live database while
the built instance was serving:

```
02:42:10Z  GET /api/v1/health
{ "status": "down",
  "version": "m15-with-schema-check",
  "checks": { "db": { "ok": true },
              "schema": { "ok": false,
                          "detail": "the database is missing 1 column(s) this build expects:
                                     agent_runs.final_output. A migration and the code that
                                     depends on it shipped together; see
                                     docs/runbooks/db-migration-failed.md." } } }

02:42:10Z  deploy.yml post-deploy smoke check
--- /api/v1/health
FAIL: /health
smoke exit=1
```

And at boot, from the built `dist`:

```
{"level":50,…,"missing":["agent_runs.final_output"],
 "msg":"schema check FAILED: this build and the database disagree. /health will report down.
        See docs/runbooks/db-migration-failed.md."}
```

Three consequences follow automatically, with no new workflow step and no new credential:
`deploy.yml`'s "Wait for the new version to serve traffic" never sees `ok` or `degraded` so
the deploy fails and the old instance keeps serving; the post-deploy smoke check fails at
its first assertion; and `.github/workflows/uptime.yml` sees `status=down` and files an
issue labelled `incident`. Renaming the column back restored `status: ok` without a restart
(the check is re-evaluated every 60 s).

## Lessons for the curriculum

1. **"Health ≠ correctness" deserves to be taught with this exact artefact.** Module 6
   lesson 4 sends the reader to `/ops`; it should also show the `/health` body from
   02:19:38Z — `{"status":"ok"}` — next to the 500 from the same instance one second later.
   A green health check over a broken app is more convincing as a screenshot than as a
   principle.
2. **Add the three-deploy expand/contract walkthrough to a lesson, not only to a runbook.**
   The runbook has it and it is good; it is read during an incident, which is the worst
   time to learn something. The observation that makes it click is that the review diff
   *is internally consistent* — the rename is correct in every file — and the bug is
   entirely in the fact that the two halves land at different times.
3. **"A guard that never runs provides no assurance" is now a theme with three instances**
   (the Dockerfile that could not build, ADR 0004; the integration suite here; and the
   whole of `ci.yml`). It belongs in the harnesses module's lesson on what a real
   harness adds, alongside the point that a test suite is only as good as the trigger that
   invokes it.
4. **Teach the generated column as a mitigation.** It is a genuinely useful, low-risk,
   zero-deploy escape hatch for a rename gone wrong, and it is not obvious. One `ALTER
   TABLE` bought a complete recovery while the real fix was built calmly.
5. **The SLI that goes quiet when the thing it measures breaks** is a subtle and general
   failure mode, and this incident produced a clean example of it. It is worth a paragraph
   wherever SLIs are introduced: prefer indicators that fail *loud* (a ratio over a
   denominator that stays put) to ones that fail *absent*.
