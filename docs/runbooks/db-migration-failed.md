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
  `INTERNAL_ERROR` in the body and, in the logs, a Postgres error naming a column. This is
  the bad case: the migration *succeeded* and the code does not match the schema it
  produced. That is the expand/contract failure, below.
- **`/api/v1/health` reports `{"status":"down", "checks":{"db":{"ok":true},
  "schema":{"ok":false,...}}}`.** Since M15 this is the *fast* path to the answer: the
  `schema` check compares the columns drizzle declares with the columns Postgres has, and
  its `detail` names the missing ones. If you see it, you are in the bad case and you
  already know which column moved. It is also what fails the deploy — see
  *Diagnose* step 1.

## Diagnose

**1. Which case are you in?** One request answers it:

```bash
curl -s https://<your-service>.onrender.com/api/v1/health | jq
```

- `version` is the **old** commit → the deploy was blocked. The app is fine. You have
  time. Go to *Mitigate → the migration failed*.
- `version` is the **new** commit and `status` is `down` with `checks.db.ok = true` →
  the migration ran and the code disagrees with it, and `checks.schema.detail` already
  names the columns. Go to *Mitigate → the migration succeeded and broke the app*. (This
  is also why the deploy did not finish: `deploy.yml` waits for `ok` or `degraded`, so a
  schema mismatch aborts the deploy and leaves the previous instance serving.)
- `version` is the **new** commit and `status` is `ok` but routes are 500ing → the
  migration ran and the code disagrees with it in a way the schema check cannot see — a
  type, a constraint, a view, an enum value. Same mitigation, more digging.
- `status` is `down` **and `checks.db.ok` is false** → the database is unreachable, which
  is a different problem; check Neon's status page and `DATABASE_URL` before assuming it
  is the migration. (`checks.db` is the discriminator: `down` alone no longer means
  "cannot reach Postgres".)

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

   **If you need service back before a build finishes, use a generated column.** This was
   measured in M15: it restored every 500ing route *in the same second*, with no deploy,
   while the real fix was written calmly.

   ```sql
   -- The running image writes `output` and reads `final_output`. Give it both.
   ALTER TABLE agent_runs
     ADD COLUMN final_output text GENERATED ALWAYS AS (output) STORED;
   ```

   It works for a rename because Postgres accepts `DEFAULT` for a generated column in an
   `INSERT`, which is exactly what drizzle emits for a column it is not setting — so reads
   *and* writes recover. Retire it in the real fix (drop the generated column, then
   rename back), because a generated column is one-way: writes still have to go to
   `output`.

3. **Restore** (only if rows are gone): Neon keeps point-in-time history on the free
   plan. Neon console → the project → Branches → **Create branch from a timestamp**, a
   minute before the migration. That gives you a *new* branch with its own connection
   string; nothing is overwritten. Point a `psql` at it, confirm the data is what you
   expect, and then either copy the missing rows across or repoint `DATABASE_URL` at the
   branch. Never restore by dropping and recreating the main branch under a running app.

## Verify

```bash
# 1. Health reports the commit you intended to ship — and that the schema matches it.
curl -s "$APP_URL/api/v1/health" | jq '{status, version, db: .checks.db.ok, schema: .checks.schema}'

# 2. The route that was 500ing is not.
curl -s -o /dev/null -w '%{http_code}\n' "$APP_URL/api/v1/modules"   # expect 401

# 3. The schema is what the code expects.
psql "$DATABASE_URL" -c '\d agent_runs'
```

Then open the site, log in and **load a run page** — `/runs`, then a run. `/health` being
green proves the process started and, since M15, that the columns exist; it still proves
nothing about the queries themselves.

## Follow-ups

- **Write the postmortem**, from `docs/postmortems/TEMPLATE.md`. Blameless: the
  interesting question is never "who wrote the migration", it is "what made the bad
  version look fine in review". There is a worked example next to the template —
  `docs/postmortems/2026-09-20-rename-final-output.md`, the M15 exercise — including the
  full list of monitors that stayed silent and why.
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

M15 shipped that mistake deliberately, on purpose, to see it happen. This runbook is what
was being read when it did — see
[`docs/postmortems/2026-09-20-rename-final-output.md`](../postmortems/2026-09-20-rename-final-output.md)
for the real timeline, the real error text and what the monitoring did and did not notice.

Two things that postmortem changed here:

- **The schema check now exists** (`apps/api/src/db/schemaCheck.ts`). It is the reason
  `/health` can report `down` for a schema mismatch, and it is the only monitor that
  noticed the incident at all. Note what it deliberately does *not* flag: a column the
  database has and the code does not. That is the expand phase above, and a check that
  called it drift would forbid the discipline this whole section is arguing for.
- **A guard that never runs provides no assurance.** The integration suite catches this
  mistake in 49 seconds and did not, because this repository has no remote and `ci.yml`
  has never executed (`docs/adr/0004` § 5 and its addendum). If you are reading this
  because it happened to you, check *that* first.
