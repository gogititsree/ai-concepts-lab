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
   migrations out of server start, so two instances can never race them.
4. Environment variables:

| Key | Value |
|---|---|
| `DATABASE_URL` | the Neon pooled string |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `MFA_ENCRYPTION_KEY` | `openssl rand -base64 32` (exactly 32 bytes decoded) |
| `APP_ORIGIN` | `https://<your-service>.onrender.com` |
| `MODEL_PROVIDER` | `none` (decision 1: the free tier has no GPU) |
| `COOKIE_SECURE` | `true` |
| `TRUST_PROXY` | `true` |
| `NODE_ENV` | `production` |

`MFA_ENCRYPTION_KEY` is the one to be careful with. Change it and every enrolled
authenticator stops working, because the stored TOTP secrets can no longer be decrypted.

5. Settings → Deploy Hook → copy the URL.

### Wire the deploy workflow

```bash
gh secret set RENDER_DEPLOY_HOOK_URL --body 'https://api.render.com/deploy/srv-...'
gh variable set APP_URL --body 'https://<your-service>.onrender.com'
```

`deploy.yml` then runs after a green CI on `main`, pokes the hook, and polls
`/api/v1/health` until the reported `version` matches the commit.

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
