# ADR 0005 — Seven decisions in M13's production hardening

- **Status:** accepted
- **Date:** 2026-09-19 (M13, production hardening on Render + Neon)
- **Deviates from:** `docs/05-quality-and-ops.md` → "Secrets management" (`config.ts`
  fails fast if missing) and "`deploy.yml`" (steps 3 and 4); `docs/06-roadmap.md` → M13
  (the Render pre-deploy command); and the implicit assumption in `docker/Dockerfile`
  that `GIT_SHA` always arrives as a build arg.

Nothing was deployed while this was written: there is still no git remote and no Render
service (see `docs/github-setup.md`, and ADR 0004 §5 for the same caveat one milestone
earlier). Everything below was verified against the locally built Docker image and the
Playwright suite running the production entrypoint; the two items that can only be
verified on Render are flagged as such.

---

## 1. `MAINTENANCE_TOKEN` is optional in production, and the route fails closed

`docs/05` says of the production secrets: "`config.ts` fails fast if missing." M13 adds
a fifth secret, `MAINTENANCE_TOKEN`, and it is deliberately **not** on that list. The
app boots without it, logs a `warn`, and `POST /api/v1/ops/maintenance` answers
`503 MAINTENANCE_DISABLED`.

The rule is right for the other four because each one is load-bearing: without
`DATABASE_URL` there is no application, and without `SESSION_SECRET` or
`MFA_ENCRYPTION_KEY` the app would run with a committed development key, which is worse
than not running. `MAINTENANCE_TOKEN` gates *retention*. An expired session is already
refused by the guard; an old `agent_runs` row is inert. Making it mandatory converts
"the cleanup schedule is not wired up yet" into "the site will not boot" — a strictly
worse outage in exchange for a strictly less important feature, and one that would fire
on the very first deploy, before the owner has had a chance to set the variable.

There is also a practical constraint that makes the alternative untestable: the
Playwright suite runs the real production entrypoint with `NODE_ENV=production` and
supplies only the secrets it needs (`playwright.config.ts`). Requiring a fifth one would
mean the end-to-end proof for this milestone could not start.

Rejected alternatives: **a default token** (a shipped default on an endpoint that deletes
rows is indefensible), and **leaving the route unauthenticated when no token is set**
(fails open — the exact inversion of what a missing credential should do).

The 503-versus-401 split matters too. "Switched off" and "your token is wrong" are
different problems with different fixes, and the person debugging the schedule at 2am
needs to be told which one they have.

## 2. `style-src` keeps `'unsafe-inline'`; `script-src` does not

The shipped policy is:

```
default-src 'self'; base-uri 'self'; script-src 'self'; script-src-attr 'none';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';
worker-src 'self'; child-src 'self'; frame-src 'none'; frame-ancestors 'none';
object-src 'none'; form-action 'self'; manifest-src 'self'; media-src 'none';
upgrade-insecure-requests
```

`'unsafe-inline'` in `style-src` is not laziness, it is forced, three times over: KaTeX
renders every formula with inline `style="…"` attributes, CodeMirror 6 injects `<style>`
elements at runtime through style-mod, and the visualisations use React `style={{…}}`
props. Neither a nonce nor a hash can authorise a style *attribute* generated at render
time.

It is also much cheaper than its script-side namesake. The exposure is CSS injection —
data exfiltration through attribute selectors — and it requires attacker-controlled
markup to land in the DOM in the first place. The only markup this app renders that it
did not write is curriculum Markdown, which comes from `content/` in this repository via
the seed.

`script-src` stays `'self'` with no inline and no eval, because the Vite build emits no
inline script (`apps/web/dist/index.html` is two `<link>`s and one `<script src>`) and
therefore nothing has to be relaxed for it.

## 3. The harness worker gets its own, looser CSP — served with the worker script

Module 6 compiles the learner's `runAgent` with `new Function`, which CSP treats as
`eval`. Under `script-src 'self'` that throws, and it throws **only in production**,
only in Module 6 — precisely the failure this milestone exists to prevent.

The obvious fix, adding `'unsafe-eval'` to the document's `script-src`, re-enables `eval`
for the entire application to serve one exercise. Instead, the response that carries the
worker script carries a different policy:

```
default-src 'none'; script-src 'self' 'unsafe-eval'
```

This works because a dedicated worker fetched over the network builds its policy
container from **its own response's** headers rather than inheriting the document's
(HTML's "run a worker" → "create a policy container from a fetch response"). Loading the
worker from a `blob:` URL would *not* work: local schemes do inherit.

The request is identified by `Sec-Fetch-Dest: worker`, a header the browser sets and page
script cannot forge, with the built filename pattern (`/assets/*worker*.js`) as a
fallback for clients without Fetch Metadata. Verified empirically — see §7.

The relaxation is scoped to one script in one realm, and it is still a policy: the
learner's code can evaluate strings and load code from this origin, and it cannot
`fetch`. It never needed to; `protocol.ts` has the *page* make model calls specifically
so the untrusted realm holds no credentials.

## 4. `GIT_SHA` no longer defaults to `dev` in the image, and is absent from `render.yaml`

`docs/05` → `deploy.yml` step 3 says "the API exposes `GIT_SHA` from a build arg", and
M1's deviation 2 added a `RENDER_GIT_COMMIT` fallback for the case where Render builds
the image itself. **That fallback could never fire.** `docker/Dockerfile` had
`ARG GIT_SHA=dev` and `ENV GIT_SHA=${GIT_SHA}`, so every image built without a build arg
— which is every image Render builds — had `GIT_SHA=dev` *set*, and `??` kept it.
`/api/v1/health` would have reported `version: "dev"` forever, and `deploy.yml`'s poll,
which waits for `version` to equal the commit it shipped, would have timed out after five
minutes on every single deploy while the app ran perfectly.

Two one-line fixes: the build arg defaults to the empty string, and `loadConfig` treats
blank as absent before falling back to `RENDER_GIT_COMMIT`. A plain `docker run` still
reports the schema default `dev`; CI still bakes in the real commit.

`GIT_SHA` was also removed from `render.yaml`, where it sat as `sync: false`. A value
pinned in the dashboard goes stale on the next deploy, at which point the poll either
hangs or — worse — passes against the old code. Nothing to configure is the correct
amount of configuration.

**Verified locally only.** That Render actually sets `RENDER_GIT_COMMIT` at runtime
cannot be checked without a Render service.

## 5. The post-deploy smoke check does not fetch six modules, and cannot check a run page

`docs/05` → `deploy.yml` step 4 is: "Post-deploy smoke: `GET /api/v1/modules` returns 6
modules." As written that is impossible. `/api/v1/modules` is inside the
`requireFullSession` scope, so an unauthenticated request returns **401** — which is what
the workflow now asserts, and it is the more valuable assertion: a 404 would mean the SPA
fallback is swallowing `/api`, and a 200 would mean the content API is exposed to the
internet without a session.

`docs/05` → "Runbooks" and the M13 task list also ask for a smoke check on a run page.
That is not feasible here, for two independent reasons:

1. Creating a run needs a full session — register, enroll a second factor, log in with a
   TOTP. Doing that from CI means a real account's password and TOTP seed in GitHub
   secrets and a smoke test that writes rows into the production database on every
   deploy.
2. Even with credentials there would be nothing to check: the deployment runs
   `MODEL_PROVIDER=none` (decision 1), so `POST /model/runs` answers 503 **by design**.

The substitute is an assertion that `GET /api/v1/model/health` reports `provider: none` —
verifying that decision 1 is actually in force rather than pretending a run could happen.
If that ever says `ollama`, the instance is about to spend 90 s per request failing to
reach a localhost that does not exist. The full journey is covered by the Playwright
suite in `ci.yml`, against a build of the same commit, before `deploy.yml` runs at all.

The other smoke checks: `checks.db.ok` (a green deploy that cannot reach its database is
the worst kind of green), `/` returning the SPA shell **and** the JS bundle it references
(if `apps/web/dist` were missing from the image the API would be perfectly healthy and
the site would be a 404), and the presence of the CSP, HSTS and `nosniff` headers.

The health poll now also accepts `degraded`, as `docs/05` specifies and as the previous
code did not — the deployment has no model, so a dependency check reporting one missing
must never fail a deploy.

## 6. Pool of 3, prepared statements off on a pooled endpoint, shutdown extracted

Three changes to how the app talks to Neon, all of them sized by the *deployment* rather
than by the database:

- **`DB_POOL_MAX` 5 → 3.** The binding constraint is one Render free instance at 0.1 CPU
  serving a solo learner; three concurrent queries is already three concurrent requests
  doing real work. The saved connections are not saved from nothing — the pre-deploy
  migration, a `pnpm db:seed` from a shell and any `psql` session draw on the same
  free-tier allowance, and the failure mode when it runs out is a deploy whose
  *migration* cannot connect.
- **`idle_timeout` 30 s, `connect_timeout` 10 s, `max_lifetime` 15 min.** postgres.js
  keeps idle connections open forever by default, which both occupies pooler slots and
  keeps a scale-to-zero compute awake. 10 s for connect covers a Neon compute resume
  without turning an unreachable database into a hung request.
- **`prepare: false` when the connection string names a pooler** (`-pooler.` host, or
  `?pgbouncer=true`). postgres.js uses named prepared statements by default and
  transaction-mode pooling cannot be relied on to keep a client on one server
  connection. Neon's pooler does implement prepared-statement tracking, so this may be
  unnecessary — but it is a failure that can appear *only* in production (CI runs a
  direct `postgres:16-alpine`) and costs nothing to rule out at this query volume.
  Detection is by connection string, so local and CI behaviour is unchanged.

The SIGTERM path moved from eight lines in `server.ts` to `plugins/shutdown.ts`. Those
eight lines had three failure modes invisible until the day they mattered — a rejected
`app.close()` skipping the pool drain entirely, a re-sent SIGTERM starting a second
drain, and a hang with no upper bound against Render's ~30 s grace period — and none of
them is testable inside an entrypoint that also calls `listen()`. It is now a pure
factory over injected dependencies with a unit test per path. (On Windows this is the
only way it *could* be tested: `process.kill(pid, 'SIGTERM')` terminates a child without
running its handlers.)

`server.ts` is the one file touched outside this milestone's stated ownership; the change
is five lines and the behaviour it replaces is unchanged apart from the three fixes above.

## 7. How the CSP was proved, and what is still unproven

A policy that is wrong is silent, so "it looked fine" is not evidence. What was actually
run:

- **`pnpm test:e2e` against the built app with the production policy.** The Playwright
  suite runs `NODE_ENV=production`, so it exercises the real CSP through: the SPA shell
  and bundle loading, KaTeX-rendered lesson Markdown, the **MFA enrollment QR code**
  (`data:` `img-src`), a real login, and a Module 5 agent run over SSE (`connect-src`).
- **A headless-Chromium check of the Module 6 worker** against the running Docker image,
  collecting `securitypolicyviolation` events and console errors while the worker is
  created and made to compile code with `new Function`. This is the one thing the E2E
  does not cover and the one directive most likely to be wrong.
- **`curl -I`** against the container for the header set, with and without
  `COOKIE_SECURE`.

Still unproven, and honestly so: everything that needs a real Render service and a real
Neon endpoint. `RENDER_GIT_COMMIT`, `preDeployCommand` on the free plan (§ below), HSTS
over real TLS, and whether Neon's pooler would in fact have tolerated prepared
statements.

---

## Smaller notes (not deviations, but worth finding later)

- **HSTS and `upgrade-insecure-requests` are gated on `COOKIE_SECURE`, not on
  `NODE_ENV`.** "Production" is not the same claim as "served over TLS", and the E2E is
  the proof: it runs `NODE_ENV=production` over plain `http://127.0.0.1`. Reusing the
  flag that already answers "am I behind TLS?" means the security headers and the session
  cookie cannot disagree about the scheme.
- **`preDeployCommand` may not be available on Render's free plan.** It is in
  `render.yaml` because it is the design, and `docs/github-setup.md` now documents the
  manual fallback (`DATABASE_URL=… pnpm db:migrate` before triggering the deploy). What
  it must *not* become is a migration inside the server's start-up path: start-up runs on
  every restart, so a restart loop would become a migration loop.
- **`APP_ORIGIN` is now required in production.** It had a default of
  `http://localhost:5173` — a *usable* default, which is the dangerous kind. A production
  instance that silently kept it would reject every write from its own SPA with a 403
  that looks like a session bug, and only for browsers that send `Origin`, i.e.
  intermittently.
- **The boot line.** `plugins/startup-log.ts` logs the effective configuration — after
  defaults, after coercion, after the `NODE_ENV`-dependent branches — with every secret
  reduced to `[set]`/`[unset]` and `DATABASE_URL` to `host/database`. A unit test asserts
  that no secret value appears in the serialised line, using distinctive values so the
  search cannot pass by coincidence.
- **The maintenance endpoint sends `X-Requested-With: fetch` from a GitHub Actions
  runner.** That is not a contradiction of the CSRF guard: the header defends *browsers*
  against cross-site form posts, and a header that script cannot set from another origin
  is trivially set by curl. The bearer token is the security; the header is the API's
  calling convention.
- **Retention is two rules, not one.** Whole runs are deleted at 90 days; the bulky
  `agent_run_steps.raw` payload is nulled at 14, leaving every field `/ops/sli` and the
  trace viewer read. "Shrink old rows, then delete older rows" is the shape most real
  retention policies have, and doing it here in miniature is the lesson.
