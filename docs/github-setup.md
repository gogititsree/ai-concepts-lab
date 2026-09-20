# GitHub and Render setup

Everything in `.github/` is written and its YAML parses, but **none of it has ever run**:
this repository has no remote, so there is no Actions runner and no deployment. These are
the steps only you can do, because each needs your credentials.

Do part 1 whenever you like. Part 2 is milestone M13's prerequisite.

---

## 1. Create the repository and turn CI on

```bash
# From the repo root. Private is fine; Actions minutes are free either way for public repos.
gh repo create ai-concepts-lab --private --source=. --remote=origin
git push -u origin main
```

The first push triggers `.github/workflows/ci.yml`. Watch it:

```bash
gh run watch
```

Expect the first run to be slower than later ones: the pnpm store, the Playwright browser
and the Docker layer caches are all cold.

### Required status checks and branch protection

`CLAUDE.md` mandates branch-per-milestone, so make `main` enforce it:

```bash
gh api -X PUT repos/:owner/ai-concepts-lab/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Lint and typecheck", "Unit tests", "Integration tests", "End-to-end (Playwright)"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Two notes. The `contexts` strings are the jobs' `name:` values, not their ids, and they
must match exactly or the check never becomes required. `required_pull_request_reviews` is
`null` on purpose: a solo maintainer cannot approve their own pull request, so requiring a
review would lock you out of your own repository. You still get the workflow by opening a
pull request per milestone; the protection stops you pushing to `main` by accident.

If you prefer clicking: Settings → Branches → Add rule → `main` → tick "Require status
checks to pass", search for the four job names, and tick "Do not allow force pushes".

---

## 2. Render and Neon, for M13

### Neon (Postgres)

1. Create a project at neon.tech. The free tier needs no card.
2. Copy the **pooled** connection string. The pooled one matters: Render's free instance
   plus migrations plus the app will otherwise exhaust direct connections.
3. Keep it for `DATABASE_URL` below.

### Render (the web service)

1. New → Web Service → connect the GitHub repository.
2. Runtime **Docker**, Dockerfile path `docker/Dockerfile`, plan **Free**.
3. **Pre-deploy command**: `node apps/api/dist/db/migrate.js`. This is the step that keeps
   migrations out of server start, so two instances can never race them, and a failed
   migration aborts the deploy with the previous version still serving.

   **Caveat, and check this before you rely on it:** Render restricts pre-deploy commands
   to paid instance types. If the Free plan will not accept the field (it is also set in
   `render.yaml`, which the blueprint applies), run migrations by hand immediately before
   triggering a deploy:

   ```bash
   DATABASE_URL='<neon pooled url>' pnpm db:migrate
   ```

   Do *not* work around it by moving migrations into the server's start-up path. The
   whole reason they are a separate step is that start-up runs on every restart, and a
   restart loop would then be a migration loop. `docs/runbooks/db-migration-failed.md`
   covers what to do when one fails either way.
4. Environment variables. This table and the `envVars:` block in `render.yaml` are the
   same list; if they ever disagree, one of them is a bug:

| Key | Value | Secret? |
|---|---|---|
| `NODE_ENV` | `production` | no |
| `PORT` | `3000` | no |
| `DATABASE_URL` | the Neon **pooled** string | yes |
| `DB_POOL_MAX` | `3` | no |
| `SESSION_SECRET` | `openssl rand -base64 48` | yes |
| `APP_ORIGIN` | `https://<your-service>.onrender.com` | no |
| `COOKIE_SECURE` | `true` | no |
| `TRUST_PROXY` | `true` | no |
| `MFA_ENCRYPTION_KEY` | `openssl rand -base64 32` (exactly 32 bytes decoded) | yes |
| `MAINTENANCE_TOKEN` | `openssl rand -base64 36` | yes |
| `METRICS_TOKEN` | `openssl rand -base64 24` | yes |
| `MODEL_PROVIDER` | `none` (decision 1: the free tier has no GPU) | no |

Four of these are required in production and the app **refuses to boot** without them,
with the offending variable named in the error: `DATABASE_URL`, `SESSION_SECRET`,
`MFA_ENCRYPTION_KEY` and `APP_ORIGIN`. That is deliberate — each one has a default that
would otherwise "work" and be wrong (a localhost database, a committed dev secret, an
origin pointing at the Vite dev server). The first line in the log of every deploy is the
effective configuration with the secrets redacted, so you can see what the instance
actually resolved.

`MAINTENANCE_TOKEN` and `METRICS_TOKEN` are the exceptions: the app boots without them
and `POST /api/v1/ops/maintenance` / `GET /metrics` answer 503. Both fail **closed** — an
unset token means the endpoint is off, never that it is open — and neither is worth
refusing to start over. Housekeeping is retention, not correctness, and a missing
scrape token should not be able to take the site down.

**Do not set `GIT_SHA`.** Render injects `RENDER_GIT_COMMIT` on every deploy and the app
falls back to it; a value pinned in the dashboard would go stale on the next deploy, and
`deploy.yml` — which polls `/api/v1/health` until `version` equals the commit it shipped
— would then either hang for five minutes or pass against the old code.

`MFA_ENCRYPTION_KEY` is the one to be careful with. Change it and every enrolled
authenticator stops working, because the stored TOTP secrets can no longer be decrypted.
There is a correct way to rotate it; it is in `docs/runbooks/secrets-rotation.md`.

5. Settings → Deploy Hook → copy the URL.

### Wire the deploy workflow

```bash
gh secret set RENDER_DEPLOY_HOOK_URL --body 'https://api.render.com/deploy/srv-...'
gh variable set APP_URL --body 'https://<your-service>.onrender.com'
# The same value you put in Render's MAINTENANCE_TOKEN, character for character.
gh secret set MAINTENANCE_TOKEN --body '<the token from the table above>'
```

`deploy.yml` then runs after a green CI on `main`, pokes the hook, and polls
`/api/v1/health` until the reported `version` matches the commit (five minutes, which is
the cold-start budget). It then runs a post-deploy smoke check that goes past `/health`:
`/api/v1/modules` must answer **401** (the router is mounted and the session guard is
on), `/api/v1/model/health` must report provider `none` (decision 1 is in force), `/`
must return the SPA shell *and* the JS bundle it references, and the response must carry
a CSP, HSTS and `nosniff`.

`maintenance.yml` uses `MAINTENANCE_TOKEN` and `APP_URL`. It runs daily at 03:17 UTC and
can be triggered by hand from the Actions tab; it deletes expired sessions and abandoned
MFA enrollments, deletes agent runs older than 90 days, and clears the bulky `raw`
payload from run steps older than 14 days. See `docs/runbooks/session-cleanup.md` and
`docs/runbooks/run-retention.md`.

### After the first deploy

Seed the content once, from a Render shell or locally against the Neon URL:

```bash
DATABASE_URL='<neon pooled url>' pnpm db:seed
```

Then check it: register an account on the live URL, enroll MFA, and open Module 1. Modules
4 to 6 will show the "run it locally" banner, which is correct — that is decision 1 working,
not a bug.

**Expect a cold start.** A free Render service sleeps after inactivity and the first request
afterwards takes 30 to 60 seconds. The health poll in `deploy.yml` allows five minutes for
exactly this reason.
