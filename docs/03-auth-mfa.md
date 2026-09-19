# 03 — Authentication and MFA

## Decisions

| Concern | Decision | Reasoning |
|---|---|---|
| Password storage | **argon2id**, memoryCost 64 MiB, timeCost 3, parallelism 1, via the `argon2` npm package | OWASP's current first choice. Parameters are stored inside the encoded hash, so they can be raised later and old hashes re-hashed on next successful login (`argon2.needsRehash`). |
| Password policy | 12–128 chars, no composition rules, reject the top-10k common list bundled in repo, Unicode allowed | NIST SP 800-63B. Length beats complexity. |
| Session vs JWT | **Server-side sessions, opaque cookie token, stored in Postgres** | Single first-party SPA on the same origin. Needs instant revocation (logout, password change, "log out everywhere"), and a natural place to hold the *pending-MFA* state between step 1 and step 2. JWTs would add expiry/refresh/blacklist machinery to solve problems this app doesn't have. The tradeoff (a DB read per request) is irrelevant at this scale and the lookup is a PK hit. |
| Cookie | `sid`; `HttpOnly; Secure (prod); SameSite=Lax; Path=/`; value = 32 random bytes base64url | Not readable by JS; only `sha256(token)` is stored, so a DB leak doesn't yield usable sessions. |
| CSRF | `SameSite=Lax` **plus** required header `X-Requested-With: fetch` on every non-GET; API also verifies `Origin`/`Referer` matches the configured `APP_ORIGIN` when present | Belt and braces; the header check is easy to unit-test and teaches the mechanism. |
| Lifetimes | Full session: 7-day idle, 30-day absolute. Pending-MFA session: 10 min. | |
| TOTP | RFC 6238, SHA-1, 6 digits, 30 s period, accept window ±1 step; **replay protection** via `mfa_totp.last_used_step` | Matches every authenticator app. |
| TOTP secret at rest | AES-256-GCM with `MFA_ENCRYPTION_KEY` (32 bytes, env), per-row random IV, `key_version` column | A DB dump alone must not let an attacker mint codes. |
| Backup codes | 10 codes, format `xxxxx-xxxxx` (Crockford base32, from `crypto.randomBytes`), shown once, stored as argon2id hashes, single-use | |
| Rate limits (`@fastify/rate-limit`, Postgres-backed or in-memory for single instance) | Login: 10 / 15 min per IP and 10 / 15 min per email. MFA verify: 5 / 15 min per session (then the pending session is revoked). Register: 5 / hour per IP. | Failed logins also increment `users.failed_login_count`; 10 failures → `locked_until = now()+15 min`. |
| Enumeration | Login and register return identical timing-normalised errors ("Invalid email or password"; register: "If this email is new, an account was created" is *not* used — solo app, register just fails with 409 for simplicity, documented as a deliberate tradeoff) | |
| Step-up | Enrolling, disabling MFA, regenerating codes and changing password require the current password in the request (and a current TOTP code where MFA is on) | |
| Not in scope initially | Email verification, password reset, OAuth | All need an outbound email provider. Flagged in 11-open-decisions.md as a later milestone. |

## Flows, step by step

### Register
1. `POST /auth/register {email, password, displayName}` — Zod validates; password policy checked.
2. `argon2.hash(password)` → insert `users` (`mfa_enabled=false`).
3. Create session: `token = randomBytes(32)`, `id = sha256(token)`, `mfa_verified_at = now()` (no MFA yet), `expires_at = now()+7d`.
4. `Set-Cookie: sid=<base64url(token)>; HttpOnly; Secure; SameSite=Lax; Path=/`.
5. Audit `register`. Respond `201 {user}`.

### Login (step 1: password)
1. `POST /auth/login {email, password}`.
2. Rate-limit check (IP + email). Look up user by `email` (citext).
3. If missing: run `argon2.verify` against a fixed dummy hash anyway (constant time-ish), audit `login_failed` with `user_id=null`, respond `401 INVALID_CREDENTIALS`.
4. If `locked_until > now()`: respond `423 LOCKED` (audit `login_failed{reason:'locked'}`).
5. `argon2.verify(hash, password)`. On failure: increment `failed_login_count`; if ≥ 10 set `locked_until`; audit; `401`.
6. On success: reset `failed_login_count`; if `argon2.needsRehash` → rehash and update.
7. Create session. **If `user.mfa_enabled`**: `mfa_verified_at = NULL`, `expires_at = now()+10min`, respond `200 {status:'mfa_required'}`. Audit `mfa_challenge`.
   **Else**: `mfa_verified_at = now()`, respond `200 {status:'ok', user}`. Audit `login_success`.
8. Set cookie in both cases.

### Login (step 2: MFA)
1. `POST /auth/mfa/verify {code}` with the pending session cookie.
2. Guard: session exists, not revoked/expired, `mfa_verified_at IS NULL`, user has `mfa_enabled`. Otherwise `401`.
3. Rate-limit per session (5 / 15 min). On the 6th, revoke the pending session and respond `429`.
4. Normalise input. If it matches `^\d{6}$` → TOTP path; if it matches the backup format → backup path; else `400`.
5. **TOTP path:** decrypt secret; `otplib.authenticator.checkDelta(code, secret)` with window ±1 → gives step delta; compute `step = floor(now/30)+delta`; reject if `step <= last_used_step` (replay); on success `UPDATE mfa_totp SET last_used_step = step`.
6. **Backup path:** load unused codes; `argon2.verify` each (≤10) until match; mark `used_at`; audit `backup_code_used`; response includes `usedBackupCode:true, remainingBackupCodes:n` so the UI can nag when ≤ 2 remain.
7. On success: `UPDATE sessions SET mfa_verified_at = now(), expires_at = now()+7d`; audit `mfa_success`; respond `{status:'ok', user}`.
8. On failure: audit `mfa_failed`; `401 INVALID_CODE`.

### Request guard (every protected route)
1. Read `sid` cookie → `sha256` → `SELECT sessions JOIN users`.
2. Reject if missing, `revoked_at` set, or `expires_at < now()` → `401 UNAUTHENTICATED`.
3. If `users.mfa_enabled AND sessions.mfa_verified_at IS NULL` → `401 MFA_REQUIRED` (frontend routes to `/login/mfa`). Only `/auth/mfa/verify`, `/auth/logout`, `/auth/me` accept a pending session.
4. Touch: if `last_seen_at` older than 5 min, update it and recompute `expires_at = min(last_seen+7d, created_at+30d)`.
5. Non-GET: require `X-Requested-With: fetch`; if `Origin` header present it must equal `APP_ORIGIN`.
6. Attach `request.user`, `request.session`. Log line includes `userId` and `sessionId` (prefix only).

### Enroll MFA
1. `POST /auth/mfa/enroll {password}` (full session required). Verify password (step-up).
2. If `mfa_enabled` already → `409`.
3. `secret = otplib.authenticator.generateSecret()` (base32). Encrypt with AES-256-GCM → upsert `mfa_totp` row with `confirmed_at=NULL`.
4. `otpauthUri = otpauth://totp/AI%20Concepts%20Lab:<email>?secret=<secret>&issuer=AI%20Concepts%20Lab&algorithm=SHA1&digits=6&period=30`.
5. Render QR server-side (`qrcode.toString(uri, {type:'svg'})`). Respond `{otpauthUri, qrSvg, secretForManualEntry}`. The secret is returned **only** here; never again.
6. Audit nothing yet (not confirmed).

### Confirm enrollment
1. `POST /auth/mfa/confirm {code}`. Load pending `mfa_totp` (`confirmed_at IS NULL`, created < 1 h ago) else `404`.
2. Verify TOTP with window ±1. On failure `400 INVALID_CODE` (limit 5 tries, then delete the pending row).
3. In one transaction: `mfa_totp.confirmed_at = now()`, `last_used_step = step`, `users.mfa_enabled = true`, delete old backup codes, generate 10 new codes → insert hashes, `sessions.mfa_verified_at = now()` for the current session, **revoke all other sessions**.
4. Audit `mfa_enrolled`. Respond `{backupCodes}` (plaintext, once). UI forces the user to download/copy before continuing.

### Regenerate backup codes
`POST /auth/mfa/backup-codes/regenerate {password, code}` → verify both → delete + insert 10 → audit → return plaintext once.

### Disable MFA
`POST /auth/mfa/disable {password, code}` → verify both → transaction: delete `mfa_totp`, delete backup codes, `users.mfa_enabled=false` → audit `mfa_disabled` → `204`.

### Change password
`PATCH /auth/password {currentPassword, newPassword}` → verify → hash → update → revoke all sessions except current → audit `password_changed`.

### Logout
`POST /auth/logout` → `revoked_at = now()` on the current session → clear cookie → audit `logout` → `204`.

### Housekeeping
- Cron-ish job (a `setInterval` in the API process is fine for a single instance, or a `pnpm --filter api cleanup` command run by a GitHub Actions schedule): delete sessions with `expires_at < now()-7d`, pending `mfa_totp` rows older than 1 h.

## Test vectors and what to test
- TOTP: RFC 6238 Appendix B vectors (secret `12345678901234567890`, time 59 → `287082` for SHA-1). Freeze time in tests with `vi.useFakeTimers`.
- Replay: same valid code twice → second rejected.
- Window: code from previous/next 30 s accepted; from ±2 rejected.
- Backup code: works once; second use rejected; counts remaining.
- Pending session cannot access `/modules`; can access `/auth/mfa/verify`.
- Lockout after 10 failures; unlock after 15 min (fake timers).
- Cookie attributes asserted on the `Set-Cookie` header.
- Missing `X-Requested-With` on POST → 403.
- Secret encryption round-trips and rejects a tampered tag.

## Threats considered and consciously accepted
- No email verification → anyone can register any address. Acceptable for a solo app; noted for later.
- Single encryption key in env → key compromise = TOTP compromise. `key_version` allows rotation later.
- In-memory rate limiter resets on deploy on a single instance. Acceptable; Postgres-backed store is a later exercise.

## M6 notes — where the implementation diverged

Everything above is what was built, with five exceptions. Each one is a place where
reality contradicted the design, not a change of mind.

### otplib 13.5 has no `authenticator`

The design says `otplib.authenticator.generateSecret()` and
`otplib.authenticator.checkDelta(code, secret)`. Those are the **v12** API. The installed
version is 13.5.0, a full rewrite: there is no `authenticator` object at all
(`require('otplib').authenticator` is `undefined`). What it exports is a functional API —
`generateSecret`, `generate`/`generateSync`, `verify`/`verifySync`, `generateURI` — plus
`TOTP`/`HOTP`/`OTP` classes, with `@noble/hashes` and `@scure/base` as the default crypto
and base32 plugins.

Two consequences for this codebase, both in `apps/api/src/auth/totp.ts`:

- The acceptance window is given in **seconds** (`epochTolerance`), not in steps. With
  `period: 30`, `epochTolerance: 30` is exactly ±1 step at every instant, which is the
  window the table above specifies.
- `verifySync` returns `{ valid, delta, epoch, timeStep }` rather than a boolean or a
  bare delta. `timeStep` **is** the RFC counter `T = floor(epoch / period)`, so the
  "compute `step = floor(now/30) + delta`" line in the Login step 2 flow is no longer
  needed — the library hands the step over directly, and that value goes straight into
  `mfa_totp.last_used_step`.

otplib 13.5 also offers an `afterTimeStep` option that would perform the replay check
inside `verifySync`. It is deliberately **not** used: it throws when the stored step is
ahead of the current one, so a clock that stepped backwards would turn a login into a 500,
and keeping the comparison in the route puts the rule next to the `UPDATE` that advances
it.

### The otpauth URI is hand-built

`generateURI` composes the label as `<issuer>:<label>`, so passing the documented label
`AI Concepts Lab:<email>` would emit the issuer twice; and it omits `algorithm`, `digits`
and `period` when they equal its defaults. The URI in the flow above spells all three out,
so `buildOtpauthUri` constructs it with `URLSearchParams` instead. The result is
byte-for-byte the URI this document specifies.

### RFC 6238 vector correction

The vector table above cites `t = 59 → 287082`, which is right. For the record, the other
SHA-1 rows of Appendix B, truncated to six digits, are `1111111109 → 081804`,
`1111111111 → 050471`, `1234567890 → 005924`, `2000000000 → 279037` and
`20000000000 → 353130`. (`050471` belongs to 1111111111, not to 1234567890 — the two rows
are adjacent in the RFC and easy to transpose.) All six are asserted in
`apps/api/test/auth-totp.test.ts`.

### Enrollment *is* audited

The Enroll flow says "audit nothing yet (not confirmed)". It now writes an `mfa_challenge`
row with `metadata: {stage: 'enrollment'}`. The reason: a successful password step-up that
hands out a fresh TOTP secret is exactly the event you want in the log when an account
turns out to have an authenticator nobody recognises, and leaving it unrecorded makes the
audit trail silent about the most interesting half of the attack. `auth_event_type` has no
`mfa_enroll_started` value and adding one would mean a migration, so the nearest truthful
type carries the stage in `metadata`. A failed password on that route is audited as
`login_failed{reason: 'step_up_bad_password'}`.

### Attempt counters are in memory, not in the schema

The design's "limit 5 tries, then delete the pending row" (Confirm) and "5 / 15 min per
session" (MFA verify) both need a counter. Neither `mfa_totp` nor `sessions` has a column
for one, and adding columns would mean a migration for state that is worthless after an
hour. Both counters therefore live in memory on the Fastify instance, exactly like the
per-email login limiter in `plugins/rate-limit.ts`, and inherit the same documented
limitation: a deploy resets them. For a single instance this is the same tradeoff the
table above already accepts.

One consequence worth naming: the MFA verify limiter is **always** on, including in the
integration suite that disables `@fastify/rate-limit`. It keys by session id, so every
login starts with a fresh budget of five and no test can starve another.
