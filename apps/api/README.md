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

| Key                  | Default                 | Notes                                                                                                                         |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`     | dev fallback            | HMAC key for the `sid` cookie; ≥ 32 chars. **Required in production.**                                                        |
| `APP_ORIGIN`         | `http://localhost:5173` | A request carrying `Origin` must match it.                                                                                    |
| `COOKIE_SECURE`      | true in production      | Leave false over plain `http://localhost` or the browser drops the cookie.                                                    |
| `TRUST_PROXY`        | `false`                 | Only true behind a real proxy; otherwise clients can spoof their IP past the rate limits.                                     |
| `MFA_ENCRYPTION_KEY` | dev fallback            | AES-256-GCM key for the TOTP secret at rest. Exactly 32 bytes, as 64 hex or 44 base64 characters. **Required in production.** |

## The auth API

Base path `/api/v1`. Design: `docs/03-auth-mfa.md`.

| Method   | Path                                | Success                                                           | Notes                                                                                                                                         |
| -------- | ----------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/auth/register`                    | `201 {user}`                                                      | Creates a session. 409 `EMAIL_TAKEN`; 5/hour per IP                                                                                           |
| `POST`   | `/auth/login`                       | `200 {status:'ok', user}`                                         | or `{status:'mfa_required'}`; 401, 423 when locked; 10/15 min per IP _and_ per email                                                          |
| `POST`   | `/auth/logout`                      | `204`                                                             | Pending-MFA sessions allowed                                                                                                                  |
| `GET`    | `/auth/me`                          | `200 {user, session}`                                             | Pending-MFA sessions allowed                                                                                                                  |
| `PATCH`  | `/auth/password`                    | `204`                                                             | Requires the current password; revokes every other session                                                                                    |
| `GET`    | `/auth/sessions`                    | `200 {sessions}`                                                  | id is the first 8 hex of `sha256(token)`                                                                                                      |
| `DELETE` | `/auth/sessions/:id`                | `204`                                                             | `:id` is that 8-character prefix **or** the full 64-character hex id; 404 if it is not yours                                                  |
| `POST`   | `/auth/mfa/enroll`                  | `200 {otpauthUri, qrSvg, secretForManualEntry}`                   | Step-up: needs the password. 403 on a wrong one; 409 `MFA_ALREADY_ENABLED`                                                                    |
| `POST`   | `/auth/mfa/confirm`                 | `200 {backupCodes}`                                               | 400 `INVALID_CODE` (with `attemptsRemaining`); 404 `NO_PENDING_ENROLLMENT`; 5 wrong codes discard the enrollment                              |
| `POST`   | `/auth/mfa/verify`                  | `200 {status:'ok', user, usedBackupCode?, remainingBackupCodes?}` | **Pending sessions only.** 400 malformed, 401 `INVALID_CODE`, 409 if already verified, 429 after 5 tries (and the pending session is revoked) |
| `POST`   | `/auth/mfa/backup-codes/regenerate` | `200 {backupCodes}`                                               | Password **and** a current code. 403 if either fails; 409 `MFA_NOT_ENABLED`                                                                   |
| `POST`   | `/auth/mfa/disable`                 | `204`                                                             | Password **and** a current code. 403 if either fails; 409 `MFA_NOT_ENABLED`                                                                   |

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

## MFA curl walkthrough

Everything below assumes the jar from the walkthrough above and a signed-in session.

`node -e` stands in for the phone. It uses the same `generateTotp` the server verifies
with, so if this produces a code the API rejects, the bug is in the API and not in your
clock.

```bash
API=http://localhost:3000/api/v1
HDR=(-H 'Content-Type: application/json' -H 'X-Requested-With: fetch')

# 1. Start enrollment. Step-up: a valid cookie is not enough, the password is required.
curl -s -b "$JAR" -X POST "$API/auth/mfa/enroll" "${HDR[@]}" \
  -d '{"password":"correct horse battery staple"}' > /tmp/enroll.json
# {"otpauthUri":"otpauth://totp/AI%20Concepts%20Lab%3Alearner%40example.com?secret=...&issuer=AI%20Concepts%20Lab&algorithm=SHA1&digits=6&period=30",
#  "qrSvg":"<svg ...>","secretForManualEntry":"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"}

SECRET=$(node -pe 'JSON.parse(require("fs").readFileSync("/tmp/enroll.json","utf8")).secretForManualEntry')

# Want the QR on screen? Write the SVG out and open it — or scan it from the web UI at
# /settings/security, which is what a human would do.
node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/enroll.json","utf8"));require("fs").writeFileSync("/tmp/qr.svg",j.qrSvg)'

# 2. Compute the current code from the manual-entry secret.
#    Run this from apps/api so `otplib` resolves; it is the same call totp.ts makes.
code() {
  node -e "
    const { generateSync } = require('otplib');
    console.log(generateSync({
      secret: process.argv[1],
      algorithm: 'sha1', digits: 6, period: 30,
      epoch: Math.floor(Date.now() / 1000),
    }));
  " "$SECRET"
}

# 3. Confirm. This is the moment MFA turns on: it also mints the backup codes, marks this
#    session verified and revokes every other session you had.
curl -s -b "$JAR" -X POST "$API/auth/mfa/confirm" "${HDR[@]}" -d "{\"code\":\"$(code)\"}"
# {"backupCodes":["9k3xq-m7b2t", ... 10 of them ...]}
# Save them. This is the only time they exist in plaintext.

# 4. Log out and log back in: now step 1 only gets you a pending session.
curl -s -b "$JAR" -c "$JAR" -X POST "$API/auth/logout" -H 'X-Requested-With: fetch'
curl -s -c "$JAR" -X POST "$API/auth/login" "${HDR[@]}" \
  -d '{"email":"learner@example.com","password":"correct horse battery staple"}'
# {"status":"mfa_required"}

# A guarded route refuses it, with a code distinct from UNAUTHENTICATED.
curl -s -b "$JAR" "$API/auth/sessions"
# {"error":{"code":"MFA_REQUIRED","message":"Multi-factor authentication required"}}

# ...but /auth/me answers, so the SPA knows who it is challenging.
curl -s -b "$JAR" "$API/auth/me"
# {"user":{...,"mfaEnabled":true},"session":{"mfaVerified":false,...},"remainingBackupCodes":10}

# 5. Step 2. Wait for the next 30-second window first, or this is a replay of the code
#    you just spent on /auth/mfa/confirm and the API will say so.
sleep 31
curl -s -b "$JAR" -X POST "$API/auth/mfa/verify" "${HDR[@]}" -d "{\"code\":\"$(code)\"}"
# {"status":"ok","user":{...},"remainingBackupCodes":10}
# The session is now full: 7-day expiry, and /auth/sessions works again.

# 6. Replay the same code. `mfa_totp.last_used_step` refuses it even though the 30-second
#    window has not closed.
curl -s -b "$JAR" -X POST "$API/auth/mfa/verify" "${HDR[@]}" -d "{\"code\":\"$(code)\"}"
# {"error":{"code":"MFA_NOT_ENABLED","message":"This session has already been verified"}}
#   (from a *fresh* pending session it would be:
#    {"error":{"code":"INVALID_CODE","message":"That code has already been used"}})

# 7. A backup code works in the same field, once.
curl -s -c "$JAR" -X POST "$API/auth/login" "${HDR[@]}" \
  -d '{"email":"learner@example.com","password":"correct horse battery staple"}'
curl -s -b "$JAR" -X POST "$API/auth/mfa/verify" "${HDR[@]}" -d '{"code":"9k3xq-m7b2t"}'
# {"status":"ok","user":{...},"usedBackupCode":true,"remainingBackupCodes":9}

# 8. New backup codes. Needs the password *and* a live second factor; the old set dies.
sleep 31
curl -s -b "$JAR" -X POST "$API/auth/mfa/backup-codes/regenerate" "${HDR[@]}" \
  -d "{\"password\":\"correct horse battery staple\",\"code\":\"$(code)\"}"

# 9. Turn it off. Same proof; deletes the secret and every backup code.
sleep 31
curl -i -b "$JAR" -X POST "$API/auth/mfa/disable" "${HDR[@]}" \
  -d "{\"password\":\"correct horse battery staple\",\"code\":\"$(code)\"}"
# HTTP/1.1 204 No Content
```

### Testing against a real authenticator app

The `otpauth://` URI is standard, so any app works. Either scan `/tmp/qr.svg` (or the QR
on `/settings/security`) or add the account by hand with the manual-entry secret, issuer
`AI Concepts Lab`, SHA-1, 6 digits, 30 seconds. If the app shows a code the API rejects,
the cause is almost always clock skew on the machine running the API — the window is only
±30 seconds.

## How MFA is stored

- `mfa_totp` holds the secret as **AES-256-GCM ciphertext** plus its 12-byte IV, 16-byte
  tag and `key_version`. The key is `MFA_ENCRYPTION_KEY`, which lives in the environment
  and not in the database, so a dump alone cannot mint codes.
- `mfa_totp.last_used_step` is the RFC 6238 counter of the last accepted code. Verification
  refuses any `step <= last_used_step`, which is what stops a code being replayed inside
  its own ±1-step window.
- `mfa_backup_codes` stores argon2id hashes, never the codes. Ten per set, single use,
  `used_at` set on consumption.
- Rate limits: 5 verify attempts per 15 minutes **per session** (the sixth revokes the
  pending session and answers 429), and 5 wrong codes during enrollment throw the pending
  `mfa_totp` row away. Both counters are in memory, like the login limiter.

## How a session actually works

- The cookie holds 32 random bytes as base64url, signed with `SESSION_SECRET`.
- The database stores `sha256(token)` as `sessions.id` (`bytea` primary key). A dump of the
  table therefore contains no usable credential.
- Lifetimes: 7-day idle, 30-day absolute, recomputed when the session is touched (at most
  once every 5 minutes, so reads stay reads). Pending-MFA sessions get a flat 10 minutes.
- Revocation is a column, so logout, "log out everywhere" and password change take effect
  on the very next request.
- `sessions.mfa_verified_at` carries the MFA state: a guard answers `401 MFA_REQUIRED`
  when `users.mfa_enabled` is set and the session has not verified. Only `/auth/me`,
  `/auth/logout` and `/auth/mfa/verify` accept such a session. Verifying promotes the flat
  10-minute pending expiry to the normal 7-day idle window.
