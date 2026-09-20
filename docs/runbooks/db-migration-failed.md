# Runbook — a database migration failed

**Applies to:** the deployed Render service against Neon Postgres.
**Written for:** you, at 2am, having deployed something you no longer remember writing.
**Read first:** the box at the bottom, [Why you cannot just redeploy the old
image](#why-you-cannot-just-redeploy-the-old-image). It is the part people get wrong.

---

## Symptoms

Any of these, roughly in the order you will notice them:

- **`deploy.yml` fails at "Wait for the new version to serve traffic"** after five
  minutes. `/api/v1/health` either never answered or kept reporting the *previous*
  commit's `version`.
- **Render's Events tab shows the deploy as failed**, with the pre-deploy command's
  output — something like `error: column "final_output" of relation "agent_runs" does
  not exist`, or `PostgresError: relation "agent_runs" already exists`.
- **The site is still up and serving the old version.** This is the good case and it is
  what the pre-deploy command is for: the migration runs before the new instance starts,
  so a failure aborts the deploy rather than replacing a working app with a broken one.
- **The site is up, the new version is live, and requests 500** with
  `INTERNAL` in the body and, in the logs, a Postgres error naming a column. This is the
  bad case: the migration *succeeded* and the code does not match the schema it produced.
  That is the expand/contract failure, below.

## Diagnose

**1. Which case are you in?** One request answers it:

```bash
curl -s https://<your-service>.onrender.com/api/v1/health | jq
```

- `version` is the **old** commit → the deploy was blocked. The app is fine. You have
  time. Go to *Mitigate → the migration failed*.
- `version` is the **new** commit and `status` is `ok` but routes are 500ing → the
  migration ran and the code disagrees with it. Go to *Mitigate → the migration
  succeeded and broke the app*.
- `status` is `down` → the database is unreachable, which is a different problem; check
  Neon's status page and `DATABASE_URL` before assuming it is the migration.

**2. What did the migration actually do?** The applied-migrations table is the truth,
not the files in the repo:

```bash
# From a laptop, against the Neon pooled URL. Read-only; safe at any hour.
psql "$DATABASE_URL" -c \
  'select * from drizzle.__drizzle_migrations order by created_at desc limit 5;'
```

Compare the newest row with `apps/api/src/db/migrations/`. If the failing migration is **not**
listed, it did not commit — Drizzle runs each migration file in a transaction, so a
failure inside one leaves no partial schema. If it **is** listed, it committed and the
schema has moved.

**3. What does the schema look like now?**

```bash
psql "$DATABASE_URL" -c '\d agent_runs'
```

Believe this over your memory of the migration file.

**4. Read the pre-deploy log.** Render → the service → Events → the failed deploy →
"Pre-deploy". The Postgres error message is nearly always precise about the object it
could not find or create.

## Mitigate

### The migration failed (deploy blocked, old version still serving)

You are not in an outage. Do not start improvising against production.

1. **Reproduce it locally**, against a database that matches production's schema:

   ```bash
   pnpm db:up
   pnpm db:migrate          # applies everything from scratch on a clean lab database
   ```

   If it passes locally but failed on Neon, the difference is *state*: production has
   rows, or an earlier hand-edit, or an extension your local database has and Neon does
   not. Restore a Neon branch (below) and migrate against that.

2. **Write a forward fix. Never edit an applied migration.** A migration file that has
   already run on any database is immutable: Drizzle records a hash, so editing it makes
   the two disagree forever, and anyone else's database (including CI's) has already
   applied the old text. Add a *new* migration that repairs the state.

3. Redeploy. The pre-deploy command runs the new migration, and the deploy proceeds.

### The migration succeeded and broke the app

This is the expand/contract failure. The schema moved and the running code cannot use
it. Rolling the code back does not roll the schema back.

1. **Decide in the first minute: fix forward, or restore.** Fixing forward is almost
   always right and almost always faster. Restoring is for data loss, not for a broken
   query.

2. **Fix forward** — the usual shape is a migration that re-adds what was removed:

   ```sql
   -- Example: a rename that shipped without an expand phase.
   ALTER TABLE agent_runs RENAME COLUMN output TO final_output;
   ```

   Commit it, let CI pass, deploy. The pre-deploy command applies it before the instance
   restarts.

3. **Restore** (only if rows are gone): Neon keeps point-in-time history on the free
   plan. Neon console → the project → Branches → **Create branch from a timestamp**, a
   minute before the migration. That gives you a *new* branch with its own connection
   string; nothing is overwritten. Point a `psql` at it, confirm the data is what you
   expect, and then either copy the missing rows across or repoint `DATABASE_URL` at the
   branch. Never restore by dropping and recreating the main branch under a running app.

## Verify

```bash
# 1. Health reports the commit you intended to ship.
curl -s "$APP_URL/api/v1/health" | jq '{status, version, db: .checks.db.ok}'

# 2. The route that was 500ing is not.
curl -s -o /dev/null -w '%{http_code}\n' "$APP_URL/api/v1/modules"   # expect 401

# 3. The schema is what the code expects.
psql "$DATABASE_URL" -c '\d agent_runs'
```

Then open the site, log in and load a module. `/health` being green proves the process
started; it proves nothing about the queries.

## Follow-ups

- **Write the postmortem.** M15 in `docs/06-roadmap.md` exists to practise exactly this.
  Blameless: the interesting question is never "who wrote the migration", it is "what
  made the bad version look fine in review".
- **Add the missing test.** A migration failure that CI's `integration` job did not catch
  means the job's Postgres and production's schema had diverged, usually because a
  migration was applied to a long-lived local database and never to a clean one. CI
  migrates from empty on every run; if it passed and production did not, find the state
  difference and encode it.
- **Check whether the change should have been expand/contract** and, if so, write it down
  in the postmortem. See below.

---

## Why you cannot just redeploy the old image

The instinct — "roll back to the previous deploy, fix it in the morning" — is a trap the
moment a migration has committed, and it is worth understanding *why* before you need it.

A deploy is two artefacts with different revert semantics:

| | code | schema |
|---|---|---|
| lives in | the container image | the database |
| rolling back | pull the previous tag, restart | **there is no previous tag** |
| cost of getting it wrong | a restart | data |

Redeploying the old image gives you old code against **new** schema. If the migration
renamed `agent_runs.final_output` to `output`, the old code selects `final_output`,
which no longer exists, and every run page 500s — the same outage, now with the added
confusion that you "rolled back" and it did not help. If the migration *dropped* a
column, the old code's INSERT may still succeed while silently writing nothing, which is
worse than an error because it is quiet.

And the down-migration is not the answer either. A down-migration that recreates a
dropped column recreates it **empty**: the schema is restored and the data is not. That
is why this project has a policy and not a `drizzle-kit down`:

> **Migrations are forward-only. Never edit an applied migration; fix with a new one.**

### Expand / contract, which is how you avoid needing any of this

The rule: **a schema change and the code that depends on it never ship together.** Every
destructive change becomes three deploys, and every intermediate state is one where both
the old and the new code work.

Renaming `final_output` to `output`, done properly:

1. **Expand.** Migration adds `output`, nullable, and backfills it from `final_output`.
   Deploy. The code still reads and writes `final_output`; the new column is dead weight.
   *Both versions of the code work against this schema* — that is the property that makes
   the deploy safe.
2. **Migrate the code.** Deploy code that writes **both** columns and reads `output`,
   falling back to `final_output`. No schema change in this deploy. If it goes wrong, the
   rollback is a plain image rollback and it genuinely works, because the schema has not
   moved.
3. **Contract.** Once step 2 has been live long enough that you will not roll back to
   step 1 (a day is plenty here; at a real organisation, longer), a migration drops
   `final_output`. Deploy.

Three deploys instead of one, and at no point is there a version of the code that cannot
run against the schema in front of it. The one-step rename is the classic mistake
precisely because it looks like an obviously safe refactor in review — the diff renames a
column and renames its uses, and it is internally consistent. What review cannot see is
that the two halves land at *different times*: the pre-deploy migration runs while the
old instance is still serving traffic.

M15 ships that mistake deliberately, on purpose, to see it happen. This runbook is what
you will be reading when it does.
