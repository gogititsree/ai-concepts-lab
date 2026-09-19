# `apps/api` — Fastify API

Fastify 5 + Zod type provider + Drizzle/Postgres. `buildApp()` assembles the app without
listening so tests can drive it with `app.inject()`; `server.ts` is the entrypoint.

## Layout

```
src/
  app.ts            buildApp(): plugins, then routes
  server.ts         listen() + background jobs
  config.ts         env parsing (Zod, fails fast)
  auth/             password, session, cookies, guards, events, lockout, routes, housekeeping
  plugins/          csrf, rate-limit, error-handler
  db/               schema, client, migrations, seed
  routes/           health
```

Plugins are registered in a fixed order — `cookie → rate-limit → csrf → error handler →
routes` — for the reasons documented at the top of `app.ts`.

## Running it

```bash
pnpm setup:env          # once: creates .env and generates SESSION_SECRET
pnpm db:up              # Postgres in Docker
pnpm db:migrate
pnpm --filter api dev
```

| Script                               | What it does                                               |
| ------------------------------------ | ---------------------------------------------------------- |
| `pnpm --filter api test`             | Unit suite, no database                                    |
| `pnpm --filter api test:integration` | Integration suite; one throwaway database per file         |
| `pnpm --filter api typecheck`        | `tsc --noEmit`                                             |
| `pnpm --filter api cleanup`          | Delete long-expired sessions (also runs hourly in-process) |

## Configuration

Beyond the database settings, auth adds:

| Key              | Default                 | Notes                                                                                     |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `SESSION_SECRET` | dev fallback            | HMAC key for the `sid` cookie; ≥ 32 chars. **Required in production.**                    |
| `APP_ORIGIN`     | `http://localhost:5173` | A request carrying `Origin` must match it.                                                |
| `COOKIE_SECURE`  | true in production      | Leave false over plain `http://localhost` or the browser drops the cookie.                |
| `TRUST_PROXY`    | `false`                 | Only true behind a real proxy; otherwise clients can spoof their IP past the rate limits. |

## The auth API

Base path `/api/v1`. Design: `docs/03-auth-mfa.md`. MFA routes arrive in M6.

| Method   | Path                 | Success                   | Notes                                                                                        |
| -------- | -------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| `POST`   | `/auth/register`     | `201 {user}`              | Creates a session. 409 `EMAIL_TAKEN`; 5/hour per IP                                          |
| `POST`   | `/auth/login`        | `200 {status:'ok', user}` | or `{status:'mfa_required'}`; 401, 423 when locked; 10/15 min per IP _and_ per email         |
| `POST`   | `/auth/logout`       | `204`                     | Pending-MFA sessions allowed                                                                 |
| `GET`    | `/auth/me`           | `200 {user, session}`     | Pending-MFA sessions allowed                                                                 |
| `PATCH`  | `/auth/password`     | `204`                     | Requires the current password; revokes every other session                                   |
| `GET`    | `/auth/sessions`     | `200 {sessions}`          | id is the first 8 hex of `sha256(token)`                                                     |
| `DELETE` | `/auth/sessions/:id` | `204`                     | `:id` is that 8-character prefix **or** the full 64-character hex id; 404 if it is not yours |

Errors are always `{"error":{"code","message","details?}}` and every response carries
`x-request-id`.

### Two rules for any non-GET request

1. **`X-Requested-With: fetch` is mandatory.** A cross-site form or image tag cannot set a
   custom header, so this stops CSRF even where `SameSite=Lax` does not. Without it you
   get `403 CSRF_REJECTED`.
2. **`Origin`, if you send one, must equal `APP_ORIGIN`.** Browsers always send it;
   curl does not, which is why it is checked but not required.

## curl walkthrough

`-c`/`-b` keep the `sid` cookie in a jar, the way a browser would.

```bash
API=http://localhost:3000/api/v1
JAR=$(mktemp)

# 1. Register. Password policy: 12-128 characters, not on the bundled common list.
curl -i -c "$JAR" -X POST "$API/auth/register" \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: fetch' \
  -d '{"email":"learner@example.com","password":"correct horse battery staple","displayName":"Learner"}'
# HTTP/1.1 201 Created
# set-cookie: sid=...; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax
# {"user":{"id":"...","email":"learner@example.com","displayName":"Learner","mfaEnabled":false,"createdAt":"..."}}

# 2. Who am I? (GET needs no CSRF header)
curl -s -b "$JAR" "$API/auth/me"
# {"user":{...},"session":{"mfaVerified":true,"expiresAt":"..."}}

# 3. What happens without the CSRF header
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/logout" -b "$JAR"
# 403

# 4. Log out properly
curl -i -b "$JAR" -c "$JAR" -X POST "$API/auth/logout" -H 'X-Requested-With: fetch'
# HTTP/1.1 204 No Content

# 5. Log back in
curl -s -c "$JAR" -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  -d '{"email":"learner@example.com","password":"correct horse battery staple"}'
# {"status":"ok","user":{...}}

# 6. A wrong password — identical body and timing to an unknown email
curl -s -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  -d '{"email":"learner@example.com","password":"wrong"}'
# {"error":{"code":"INVALID_CREDENTIALS","message":"Invalid email or password"}}
# Ten of these in 15 minutes and the account answers 423 LOCKED for the next 15.

# 7. Where am I logged in?
curl -s -b "$JAR" "$API/auth/sessions"
# {"sessions":[{"id":"9f2c1a08","createdAt":"...","lastSeenAt":"...","expiresAt":"...",
#               "ip":"127.0.0.1","userAgent":"curl/8.4.0","current":true}]}

# 8. Revoke one by its 8-character id
curl -i -b "$JAR" -X DELETE "$API/auth/sessions/9f2c1a08" -H 'X-Requested-With: fetch'
# HTTP/1.1 204 No Content

# 9. Change the password (revokes every other session; this one survives)
curl -i -b "$JAR" -X PATCH "$API/auth/password" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  -d '{"currentPassword":"correct horse battery staple","newPassword":"a different long passphrase"}'
# HTTP/1.1 204 No Content
```

## How a session actually works

- The cookie holds 32 random bytes as base64url, signed with `SESSION_SECRET`.
- The database stores `sha256(token)` as `sessions.id` (`bytea` primary key). A dump of the
  table therefore contains no usable credential.
- Lifetimes: 7-day idle, 30-day absolute, recomputed when the session is touched (at most
  once every 5 minutes, so reads stay reads). Pending-MFA sessions get a flat 10 minutes.
- Revocation is a column, so logout, "log out everywhere" and password change take effect
  on the very next request.
- `sessions.mfa_verified_at` already carries the M6 semantics: a guard answers
  `401 MFA_REQUIRED` when `users.mfa_enabled` is set and the session has not verified.
  Only `/auth/me` and `/auth/logout` accept such a session (M6 adds `/auth/mfa/verify`).
