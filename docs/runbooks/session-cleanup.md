# Runbook — session and MFA-enrollment cleanup

**What this is:** the housekeeping that deletes expired `sessions` rows and abandoned
TOTP enrollments. It is **retention, not correctness** — an expired session is already
refused by the session guard, so a stale row is inert. Nothing here is ever an outage.
If you are in a hurry and something else is broken, this is not it.

**Where it runs:**

| environment | mechanism |
|---|---|
| local / `pnpm dev` | in-process hourly `setInterval` (`auth/housekeeping.ts`) |
| production | `.github/workflows/maintenance.yml`, daily at 03:17 UTC, calling `POST /api/v1/ops/maintenance` |

Production does *not* use the in-process timer, and the reason is worth remembering: a
Render free service sleeps after ~15 minutes of inactivity, and a sleeping process runs
no timers. The rows accumulate exactly during the quiet periods when nothing would be
running the cleanup. Decision 13 in `docs/07-open-decisions.md`.

**What it removes:**

| | rule | why not sooner |
|---|---|---|
| `sessions` | `expires_at` older than **7 days** | during an incident, "which sessions existed last Tuesday, and from where" is the question being asked. Deleting the instant a session expires destroys the evidence. |
| `mfa_totp` | `confirmed_at IS NULL` and `created_at` older than **1 hour** | an enrollment nobody finished. One hour is far longer than the flow takes. |

Run retention (`agent_runs`) is the same endpoint but a separate concern; see
`run-retention.md`.

---

## Symptoms

- **The Maintenance workflow is red.** Actions → Maintenance. The step log has the HTTP
  status and the response body.
- **Nothing has run for days.** The workflow's run history is the audit trail: GitHub
  disables scheduled workflows in repositories with no activity for 60 days, and it does
  so silently.
- **`sessions` is much larger than it should be.** For a solo app, more than a few
  hundred rows means the sweep has not run in a long time (or somebody is spraying the
  login route, which is a different runbook).

## Diagnose

**1. Has it been running?** Actions → Maintenance → the run list. Each successful run
prints its counts on the summary page.

**2. What does the endpoint say right now?**

```bash
export APP_URL='https://<your-service>.onrender.com'
export MAINTENANCE_TOKEN='...'   # the same value as the Render env var

curl -sS -X POST "$APP_URL/api/v1/ops/maintenance" \
  -H "Authorization: Bearer $MAINTENANCE_TOKEN" \
  -H 'X-Requested-With: fetch' \
  -w '\nHTTP %{http_code}\n' | jq
```

Read the status code first; each one means a different thing:

| status | meaning | fix |
|---|---|---|
| `200` | it ran. The body has the counts. | nothing |
| `401` | the token you sent is not the token the instance has | *Mitigate → the tokens have drifted* |
| `403` | you forgot `X-Requested-With: fetch` | add the header; the API requires it on every non-GET under `/api` |
| `503` `MAINTENANCE_DISABLED` | the instance has **no** `MAINTENANCE_TOKEN` set | *Mitigate → the endpoint is switched off* |
| timeout / 502 | the free instance is asleep or starting | retry; the workflow already retries with a 180 s timeout |

**3. How much is actually there?**

```sql
SELECT count(*) FILTER (WHERE expires_at < now())                        AS expired,
       count(*) FILTER (WHERE expires_at < now() - interval '7 days')    AS deletable,
       count(*)                                                          AS total
FROM sessions;

SELECT count(*) FROM mfa_totp
WHERE confirmed_at IS NULL AND created_at < now() - interval '1 hour';
```

`deletable` is what the next sweep will remove. If `expired` is large and `deletable` is
zero, everything is working and you are looking at the grace period.

## Mitigate

### Run it by hand

The curl above *is* the manual run — it does the work, not just a check. Or, with the
workflow: Actions → **Maintenance** → Run workflow → Run. Same thing, and it leaves a
record.

Locally, against the local database, without the HTTP route at all:

```bash
pnpm --filter api cleanup
```

### The tokens have drifted (401)

`MAINTENANCE_TOKEN` exists in two places and they must be byte-identical: the Render
environment variable and the GitHub Actions secret. Rotating one without the other is
the usual cause. `docs/runbooks/secrets-rotation.md` → `MAINTENANCE_TOKEN`.

### The endpoint is switched off (503)

The instance has no `MAINTENANCE_TOKEN`. This is a legitimate state — the app boots
without one on purpose, so that a missing cleanup token can never take the site down —
but it means the sweep has never run. Set it in Render → Environment (see
`docs/github-setup.md`), let the instance restart, and re-run the workflow.

The boot log says so too, at `warn`:

```
MAINTENANCE_TOKEN is unset: POST /api/v1/ops/maintenance is disabled, ...
```

### The schedule stopped

GitHub disables cron workflows in a repository with 60 days of no commits, and emails
about it once. Actions → Maintenance → "Enable workflow". Then push something.

### Delete rows directly (last resort)

Only if the endpoint cannot be made to work and the table is genuinely a problem. The
predicates are the same ones the code uses:

```sql
DELETE FROM sessions WHERE expires_at < now() - interval '7 days';
DELETE FROM mfa_totp WHERE confirmed_at IS NULL AND created_at < now() - interval '1 hour';
```

Do **not** delete `mfa_totp` rows that have a `confirmed_at` — those are live second
factors, and deleting one locks a user out until they use a backup code.

## Verify

```bash
# The sweep reports counts, and a second immediate run reports zeros.
curl -sS -X POST "$APP_URL/api/v1/ops/maintenance" \
  -H "Authorization: Bearer $MAINTENANCE_TOKEN" -H 'X-Requested-With: fetch' | jq
```

A second run returning `sessionsDeleted: 0, pendingMfaDeleted: 0` is the proof that the
first one actually deleted rather than reported. Then confirm you are still logged in on
the live site — the sweep must never touch a live session, and the `deletable` query
above is the same predicate the code uses, so it is easy to check.

## Follow-ups

- If the sweep regularly deletes thousands of sessions, look at *why* so many are being
  created. Every login makes one; a spike is either a broken client retry loop or a
  credential-stuffing attempt visible in `auth_events`.
- The grace period (7 days) and the pending-enrollment TTL (1 hour) are constants in
  `apps/api/src/auth/housekeeping.ts`, with the reasoning next to them. Change them
  there, not in SQL.
- The endpoint returns counts and nothing else, on purpose: the workflow log is then a
  safe, public-ish audit trail of what retention did and when.
