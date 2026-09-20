# Runbook — agent-run retention

**What this is:** the half of the maintenance sweep that ages out the observability data
in `agent_runs` / `agent_run_steps`. Same endpoint and same schedule as
`session-cleanup.md`; read that one first for how to call it, what each HTTP status
means, and how to fix a broken schedule. This page is about *what gets removed and why*,
and about the one thing here that can actually hurt — deleting traces you still needed.

**Two rules, deliberately different:**

| | rule | what survives |
|---|---|---|
| `agent_runs` | delete rows whose `started_at` is older than **90 days** | nothing; the row and its steps go |
| `agent_run_steps.raw` | set to `NULL` where `created_at` is older than **14 days** | the whole step row: kind, latency, tokens, tool name, `parse_ok`, content |

The second rule is the interesting one. `raw` is the provider's response metadata —
Ollama's timing counters, up to ~32 KB per step. It is the only genuinely large column in
the schema, it is useful for roughly as long as you are debugging the call that produced
it, and nothing reads it after that: `/ops/sli` and the trace viewer read the typed
columns beside it. So the policy is "shrink old rows, then delete older rows", which is
the shape most real retention policies have.

90 days for whole runs comes from what the rows are *for*. The SLO windows in
`docs/05-quality-and-ops.md` are 7 and 30 days; 90 leaves room to compare this quarter
with last after a model or prompt change, and is still well short of "forever". They are
also, after the auth tables, the most sensitive rows this app holds — a run contains
whatever the learner typed.

**Constants:** `RUN_RETENTION_DAYS` and `STEP_RAW_RETENTION_DAYS` in
`apps/api/src/ops/maintenance.ts`, with the reasoning next to them.

---

## Symptoms

- **Neon reports the project near its free-plan storage limit**, or queries against
  `agent_run_steps` have become noticeably slow.
- **The Maintenance workflow is red** — see `session-cleanup.md` → *Diagnose*; the
  causes and fixes are identical, because it is one endpoint.
- **A trace you wanted is gone.** The run page 404s, or `/ops` shows a gap. Check the
  dates before assuming a bug: a run from 91 days ago is *supposed* to be gone.
- **`stepRawCleared` is huge every single night.** Normal for the first sweep after a
  long gap; suspicious if it repeats, because the `raw IS NOT NULL` predicate means a
  cleared row is never counted twice. Repeated large numbers mean a lot of new steps,
  not a broken sweep.

## Diagnose

**1. What is actually in there?**

```sql
SELECT count(*)                                                       AS runs,
       count(*) FILTER (WHERE started_at < now() - interval '90 days') AS deletable,
       min(started_at)::date                                           AS oldest
FROM agent_runs;

SELECT count(*)                                                        AS steps,
       count(*) FILTER (WHERE raw IS NOT NULL)                         AS with_raw,
       count(*) FILTER (WHERE raw IS NOT NULL
                          AND created_at < now() - interval '14 days') AS clearable
FROM agent_run_steps;
```

`deletable` and `clearable` are exactly what the next sweep will act on — the SQL above
mirrors the predicates in `applyRunRetention`.

**2. Where is the space going?** Rows are not the same as bytes:

```sql
SELECT pg_size_pretty(pg_total_relation_size('agent_run_steps')) AS steps,
       pg_size_pretty(pg_total_relation_size('agent_runs'))      AS runs;
```

If `agent_run_steps` dominates and `with_raw` is large, retention is behind. If it
dominates and `with_raw` is near zero, the volume is step *rows*, not payloads, and the
90-day rule is the lever — or something is writing far more steps than expected
(a runaway loop; see `runaway-loops.md`).

**3. Note what `VACUUM` does and does not do.** Deleting rows does not return disk to
the operating system; it marks space reusable. Postgres autovacuum handles the rest and
you should let it. `VACUUM FULL` takes an ACCESS EXCLUSIVE lock and rewrites the table —
on a live free-tier instance that is an outage, and it is almost never the right answer.

## Mitigate

### Run the sweep now

```bash
export APP_URL='https://<your-service>.onrender.com'
export MAINTENANCE_TOKEN='...'

curl -sS -X POST "$APP_URL/api/v1/ops/maintenance" \
  -H "Authorization: Bearer $MAINTENANCE_TOKEN" \
  -H 'X-Requested-With: fetch' \
  -w '\nHTTP %{http_code}\n' | jq
```

```json
{
  "ranAt": "2026-09-19T03:17:04.918Z",
  "sessionsDeleted": 0,
  "pendingMfaDeleted": 0,
  "agentRunsDeleted": 12,
  "stepRawCleared": 340,
  "durationMs": 214
}
```

Or Actions → **Maintenance** → Run workflow, which leaves a record.

### Save a trace before it ages out

If there is a run you want to keep past 90 days — the one from an incident, say — copy
it out rather than special-casing retention:

```bash
psql "$DATABASE_URL" -c "\copy (
  SELECT * FROM agent_run_steps WHERE run_id = '<uuid>' ORDER BY step_index
) TO 'run-<uuid>.csv' CSV HEADER"
```

Attach it to the postmortem. A retention policy with exceptions in it is a retention
policy nobody trusts.

### You need space *now* and the sweep is not enough

Tighten the `raw` window first — it is the cheapest, least destructive lever, because the
step rows and every field the UI reads survive:

```sql
-- Drop provider payloads older than three days instead of fourteen.
UPDATE agent_run_steps SET raw = NULL
WHERE raw IS NOT NULL AND created_at < now() - interval '3 days';
```

Only then consider deleting whole runs earlier than 90 days, and change the constant in
`maintenance.ts` rather than repeatedly running ad-hoc DELETEs — otherwise the code and
the reality diverge and nobody can say what the policy is.

```sql
-- Cascades to agent_run_steps via the FK. Irreversible.
DELETE FROM agent_runs WHERE started_at < now() - interval '30 days';
```

### The sweep times out

`applyRunRetention` runs two statements, neither of which has an index that fits it
perfectly: `agent_runs` is indexed on `(status, started_at)` and `(user_id, started_at)`
but not on `started_at` alone, and `agent_run_steps` has no index on `created_at`. At
this app's volume that is a sequential scan of a small table and it does not matter — the
cost of the indexes (written on every step insert, which is the hot path) is larger than
the cost of the scan. If the sweep ever starts taking tens of seconds, that has stopped
being true and the fix is an index on `agent_run_steps (created_at) WHERE raw IS NOT
NULL`, not a bigger timeout.

## Verify

```bash
# Run it twice. The second run should report 0 for both run counters.
curl -sS -X POST "$APP_URL/api/v1/ops/maintenance" \
  -H "Authorization: Bearer $MAINTENANCE_TOKEN" -H 'X-Requested-With: fetch' | jq \
  '{agentRunsDeleted, stepRawCleared}'
```

Then re-run the counting queries from *Diagnose*: `deletable` and `clearable` should both
be 0. Finally, open `/ops` (or a recent run's page) in the app and confirm recent traces
still render — the point of nulling `raw` rather than deleting steps is that nothing
visible changes, so if something did, retention removed more than it should have.

## Follow-ups

- The integration test `apps/api/test/integration/maintenance.test.ts` inserts rows with
  an explicit age and asserts which ones survive. If you change a window, change it there
  too — that test is the executable version of the table at the top of this page.
- If runs are accumulating faster than expected, the cause is upstream: check
  `agent_runs_total` and the iterations histogram before tightening retention.
- Neon's free plan keeps point-in-time history, so a mistaken DELETE is recoverable for a
  short window by branching from a timestamp — `db-migration-failed.md` → *Restore* has
  the procedure. Recoverable is not the same as recovered; check before you rely on it.
