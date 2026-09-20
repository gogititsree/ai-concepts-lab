# Runbook — rotating a secret

**Applies to:** the deployed Render service.
**The one-line version:** three of these four secrets are a dashboard edit and a
redeploy. `MFA_ENCRYPTION_KEY` is not, and rotating it the easy way locks every user out
of their own account permanently.

| Secret | Blast radius of rotating it | Difficulty |
|---|---|---|
| `SESSION_SECRET` | everyone is logged out | trivial |
| `MAINTENANCE_TOKEN` | the nightly sweep fails until GitHub is updated too | trivial |
| `DATABASE_URL` | a few seconds of failed requests | easy |
| `MFA_ENCRYPTION_KEY` | **every enrolled authenticator stops working, irreversibly** | see below |

---

## Symptoms

You are here for one of two reasons.

**Planned.** Nothing is wrong; a secret is old, or was pasted somewhere it should not
have been, or you want to practise. Go straight to *Mitigate*.

**Unplanned — you think a secret leaked.** Signs:

- A value from the Render dashboard appears in a screenshot, a commit, a chat message or
  a pull-request description. (CI's `gitleaks` job scans history on every run; a red
  `security` job naming a file is this case.)
- `auth_events` shows logins you do not recognise, from addresses you do not recognise.
- Someone other than the scheduled workflow is calling `/api/v1/ops/maintenance` — the
  route logs a `warn` with the request id on every rejection.

## Diagnose

**Which secret, and did it actually leak?** Order of questions:

1. **Is it in git?** History, not just the working tree:

   ```bash
   git log -p -S '<the first 8 characters of the value>' --all | head -50
   ```

   If this finds nothing, and the only exposure was a screenshot you deleted, you can
   still rotate — rotation is cheap for three of the four — but the urgency is different.

2. **What can the holder do with it?** Be precise, because it decides what else you have
   to do:
   - `SESSION_SECRET` — forge the *signature* on a `sid` cookie. It does **not** grant a
     session: the cookie value is an opaque random token whose sha256 must exist as a row
     in `sessions`. Signing a token you do not know gets you a 401. So a leaked
     `SESSION_SECRET` is a "rotate promptly", not a "wake up".
   - `MFA_ENCRYPTION_KEY` — decrypt stored TOTP secrets, *if the holder also has the
     database*. On its own it is inert. Together with a `DATABASE_URL` leak it means
     every second factor is compromised and users must re-enroll.
   - `DATABASE_URL` — everything. Password hashes (argon2id, so slow to attack, but not
     nothing), emails, sessions, every prompt anyone typed. This is the "wake up" one.
   - `MAINTENANCE_TOKEN` — delete expired sessions and old runs. Annoying, not dangerous.
     It cannot read anything: the endpoint returns counts.

3. **Check whether it is still in use.** The boot line of the running instance reports,
   with every value redacted, which secrets are *set*:

   ```
   {"level":30,"msg":"effective configuration","nodeEnv":"production",
    "sessionSecret":"[set]","mfaEncryptionKey":"[set]","maintenanceToken":"[unset]", ...}
   ```

## Mitigate

### `SESSION_SECRET`

1. Generate: `openssl rand -base64 48`
2. Render → the service → Environment → edit `SESSION_SECRET` → Save. Saving triggers a
   restart.
3. That is the whole procedure. Every existing `sid` cookie now fails its signature check
   and is discarded before the database is touched, so **everyone is logged out**. The
   `sessions` rows are still there and inert; the next housekeeping sweep removes them.

Optionally, if you want the rows gone immediately (a compromise, rather than hygiene):

```sql
UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;
```

### `MAINTENANCE_TOKEN`

Two places, and they must match exactly:

```bash
TOKEN=$(openssl rand -base64 36)
gh secret set MAINTENANCE_TOKEN --body "$TOKEN"
echo "$TOKEN"   # paste into Render → Environment → MAINTENANCE_TOKEN
```

Between the two edits the nightly workflow will fail with HTTP 401. That is the expected,
visible failure — it is why the workflow exits non-zero rather than shrugging. Run it by
hand (Actions → Maintenance → Run workflow) once both sides are updated.

### `DATABASE_URL`

1. Neon console → Roles → **Reset password** for the role. The old string stops working
   immediately, so requests fail from this moment until step 2 completes — seconds, on a
   free instance that is probably asleep anyway.
2. Copy the new **pooled** string (the host with `-pooler` in it; `db/client.ts` keys its
   prepared-statement behaviour off that).
3. Render → Environment → `DATABASE_URL` → Save.
4. Wait for the restart and check `/api/v1/health` reports `checks.db.ok: true`.

### `MFA_ENCRYPTION_KEY` — read this before touching anything

**What goes wrong if you treat it like the others.** `mfa_totp.secret_ciphertext` is the
user's TOTP seed, encrypted with AES-256-GCM under this key. Change the key and the
ciphertext does not change with it: GCM authentication fails on the next verify, so
**every enrolled user's six-digit codes stop being accepted**, forever, and no amount of
putting the old key back helps once you have lost it. Recovery is per user, by hand:
they use a backup code (10 single-use ones were issued at enrollment), disable MFA, and
re-enroll. Users who have lost their backup codes are locked out of the account entirely.

So there are two procedures, and the second one is the real one.

#### (a) The blunt rotation — only if nobody has enrolled yet

Acceptable exactly when `select count(*) from mfa_totp;` is 0. Then it is a dashboard
edit like the others.

#### (b) Re-encryption, via `key_version`

The schema was built for this: `mfa_totp.key_version` is a `smallint` that says which
key a row's ciphertext is under. Today every row is `1`. The migration is:

1. **Add the new key alongside the old one.** The code must be able to decrypt with
   either during the transition, so this is a small code change, not just an environment
   edit: `config.ts` grows `MFA_ENCRYPTION_KEY_2`, and the decrypt path selects the key
   by the row's `key_version` while the encrypt path still writes version 1. Deploy.

   (This is the same expand/contract shape as a schema change — see
   `db-migration-failed.md`. Both keys valid, neither required. Nothing breaks if you
   roll back here.)

2. **Flip the writer.** Deploy the change that encrypts *new* secrets under key 2 and
   writes `key_version = 2`. Existing rows are untouched and still decrypt under key 1.

3. **Re-encrypt the backlog.** A one-off script: for each row with `key_version = 1`,
   decrypt with key 1, re-encrypt with key 2, write `secret_ciphertext`, `secret_iv`,
   `secret_tag` and `key_version = 2` in a single UPDATE per row. Idempotent, restartable,
   and safe to run against a live database — a row is either fully version 1 or fully
   version 2, never half. Run it against a Neon *branch* first and verify a known user's
   code still validates.

4. **Verify no rows remain on the old key**, then delete `MFA_ENCRYPTION_KEY` (version 1)
   from Render and remove the old-key code path.

   ```sql
   SELECT key_version, count(*) FROM mfa_totp GROUP BY key_version;
   ```

**If the key is already lost** (rotated in anger, or gone with a deleted dashboard), the
honest path is: announce it, then

```sql
-- Forces every user back through enrollment. Do not do this casually: it invalidates
-- the second factor for accounts whose owners may not read the announcement.
DELETE FROM mfa_totp;
UPDATE users SET mfa_enabled = false;
```

Users log in with their password (unaffected — argon2 hashes are not encrypted with this
key) and re-enroll.

## Verify

After any rotation:

```bash
# The instance came back up and knows which secrets it has.
curl -s "$APP_URL/api/v1/health" | jq '{status, version, db: .checks.db.ok}'
```

Then, for the one you rotated:

- `SESSION_SECRET` — your own browser is logged out; logging in again works.
- `DATABASE_URL` — `checks.db.ok` is `true`.
- `MAINTENANCE_TOKEN` — Actions → Maintenance → Run workflow → green, with counts in the
  step summary.
- `MFA_ENCRYPTION_KEY` — log in with a real authenticator app and complete the TOTP step.
  Nothing else proves it; a green `/health` proves only that the process started, and the
  key is not read until somebody verifies a code.

## Follow-ups

- **Never rotate a secret you cannot verify the same day.** `MFA_ENCRYPTION_KEY`'s failure
  mode is silent until the next login.
- If a secret reached git, rotating is necessary but not sufficient — the value is in the
  history of every clone. Rotate first, then decide whether rewriting history is worth it
  (for a private solo repository, usually not; the rotation is what matters).
- Add whatever leaked to the `gitleaks` allowlist only if it is a *false* positive.
  Silencing a true one is how the next leak goes unnoticed.
- `docs/05-quality-and-ops.md` → "Secrets management" is the inventory: where each secret
  lives and who holds it. Keep it and `docs/github-setup.md` true when you add a new one.
