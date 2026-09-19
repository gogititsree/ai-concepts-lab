import {
  BACKUP_CODE_COUNT,
  BackupCodesResponseSchema,
  classifyMfaCode,
  MfaConfirmRequestSchema,
  MfaEnrollRequestSchema,
  MfaEnrollResponseSchema,
  MfaStepUpRequestSchema,
  MfaVerifyRequestSchema,
  MfaVerifyResponseSchema,
  normaliseMfaCode,
  type MfaVerifyResponse,
} from '@lab/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { mfaEncryptionKey } from '../config.js';
import { mfaBackupCodes, mfaTotp, sessions, users } from '../db/schema.js';
import { AppError, rateLimited } from '../lib/errors.js';
import { FixedWindowLimiter } from '../plugins/rate-limit.js';
import { consumeBackupCode, countRemainingBackupCodes, replaceBackupCodes } from './backupCodes.js';
import { decryptSecret, encryptSecret, type EncryptedSecret } from './crypto.js';
import { recordAuthEvent, requestOrigin } from './events.js';
import { allowPendingSession, authContext, requireFullSession } from './guards.js';
import { verifyPassword } from './password.js';
import { toPublicUser } from './routes.js';
import {
  computeExpiry,
  revokeOtherSessions,
  revokeSession,
  sessionIdHex,
  type UserRow,
} from './session.js';
import { buildOtpauthUri, generateTotpSecret, renderQrSvg, verifyTotp } from './totp.js';

/**
 * `/api/v1/auth/mfa/*` — enrollment, the login step-2 challenge, regeneration and
 * disable. Design: `docs/03-auth-mfa.md`.
 *
 * Kept in its own plugin rather than bolted onto `routes.ts` because the MFA surface has
 * its own dependencies (crypto, TOTP, backup codes, two counters) and its own guard
 * rules, and because the one route that accepts a *pending* session lives here.
 *
 * ### The two counters
 *
 * Both are in-memory, for the same reason `plugins/rate-limit.ts` is: a single instance,
 * and a deploy resetting a counter is a worse outcome than the write amplification of
 * doing it in Postgres. They are created per Fastify instance, so a test app cannot
 * inherit another test's counts.
 *
 * - **verify**: 5 attempts / 15 minutes *per session*. On the sixth, the pending session
 *   is revoked and the caller gets a 429 — they must redo the password step, which is
 *   itself rate-limited. Keying by session rather than by user means an attacker cannot
 *   lock a victim out of their own login by burning the budget from elsewhere.
 * - **confirm**: 5 attempts per pending enrollment. On the sixth the pending row is
 *   deleted, so the user starts over with a new secret. Not time-windowed: an enrollment
 *   only lives an hour anyway, and "five tries at this QR code" is easier to explain.
 */

/** 5 verify attempts per 15 minutes per session (`docs/03-auth-mfa.md` → Rate limits). */
export const MFA_VERIFY_MAX_ATTEMPTS = 5;
export const MFA_VERIFY_WINDOW_MS = 15 * 60 * 1000;
/** 5 tries at the QR code before the pending enrollment is thrown away. */
export const MFA_CONFIRM_MAX_ATTEMPTS = 5;
/** A pending enrollment is only confirmable for an hour; housekeeping deletes it after. */
export const PENDING_ENROLLMENT_TTL_MS = 60 * 60 * 1000;

const invalidCode = (message = 'That code is not valid'): AppError =>
  new AppError(401, 'INVALID_CODE', message);

/** Step-up failures are 403, not 401: the *session* is fine, the extra proof was not. */
const stepUpFailed = (message: string): AppError =>
  new AppError(403, 'INVALID_CREDENTIALS', message);

type StoredTotp = typeof mfaTotp.$inferSelect;

function toEncryptedSecret(row: StoredTotp): EncryptedSecret {
  return {
    ciphertext: Buffer.from(row.secretCiphertext),
    iv: Buffer.from(row.secretIv),
    tag: Buffer.from(row.secretTag),
    keyVersion: row.keyVersion,
  };
}

export const mfaRoutes: FastifyPluginAsync = async (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const key = mfaEncryptionKey(app.config);

  const verifyLimiter = new FixedWindowLimiter(MFA_VERIFY_MAX_ATTEMPTS, MFA_VERIFY_WINDOW_MS);
  /** userId → failed confirm attempts against the current pending enrollment. */
  const confirmAttempts = new Map<string, number>();

  /** Loads the confirmed TOTP row, or explains why there is not one. */
  async function loadConfirmedTotp(userId: string): Promise<StoredTotp> {
    const [row] = await app.db.select().from(mfaTotp).where(eq(mfaTotp.userId, userId)).limit(1);
    if (!row || row.confirmedAt === null) {
      throw new AppError(409, 'MFA_NOT_ENABLED', 'Multi-factor authentication is not enabled');
    }
    return row;
  }

  /**
   * The shared step-up check for `disable` and `backup-codes/regenerate`: current
   * password *and* a live second factor. Returns the step the TOTP matched so the caller
   * can advance `last_used_step` where that still matters.
   */
  async function requireStepUp(
    request: FastifyRequest,
    user: UserRow,
    password: string,
    code: string,
  ): Promise<void> {
    const origin = requestOrigin(request);

    if (!(await verifyPassword(user.passwordHash, password))) {
      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'login_failed',
        ...origin,
        metadata: { reason: 'step_up_bad_password', route: request.url },
      });
      throw stepUpFailed('Current password is incorrect');
    }

    const row = await loadConfirmedTotp(user.id);
    const kind = classifyMfaCode(code);

    if (kind === 'backup') {
      const result = await consumeBackupCode(app.db, user.id, code);
      if (!result.consumed) {
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'mfa_failed',
          ...origin,
          metadata: { reason: 'bad_backup_code', route: request.url },
        });
        throw stepUpFailed('That code is not valid');
      }
      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'backup_code_used',
        ...origin,
        metadata: { remaining: result.remaining, route: request.url },
      });
      return;
    }

    const secret = decryptSecret(toEncryptedSecret(row), key);
    const verification = verifyTotp({ secret, token: code });
    // The same replay rule as login: a code already spent cannot authorise a second,
    // more destructive action inside its own 90-second window.
    if (
      !verification.valid ||
      (row.lastUsedStep !== null && verification.step! <= row.lastUsedStep)
    ) {
      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'mfa_failed',
        ...origin,
        metadata: {
          reason: verification.valid ? 'replayed_code' : 'bad_code',
          route: request.url,
        },
      });
      throw stepUpFailed('That code is not valid');
    }

    await app.db
      .update(mfaTotp)
      .set({ lastUsedStep: verification.step })
      .where(eq(mfaTotp.userId, user.id));
  }

  // -------------------------------------------------------------------- enroll ----

  routes.post(
    '/auth/mfa/enroll',
    {
      preHandler: requireFullSession,
      schema: { body: MfaEnrollRequestSchema, response: { 200: MfaEnrollResponseSchema } },
    },
    async (request) => {
      const { user } = authContext(request);
      const origin = requestOrigin(request);

      if (user.mfaEnabled) {
        throw new AppError(
          409,
          'MFA_ALREADY_ENABLED',
          'Multi-factor authentication is already enabled; disable it first',
        );
      }

      if (!(await verifyPassword(user.passwordHash, request.body.password))) {
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'login_failed',
          ...origin,
          metadata: { reason: 'step_up_bad_password', route: 'mfa/enroll' },
        });
        throw stepUpFailed('Current password is incorrect');
      }

      const secret = generateTotpSecret();
      const encrypted = encryptSecret(secret, key);

      // Upsert: starting enrollment again (a lost QR code, a different phone) must replace
      // the pending secret, not collide with it. `confirmed_at` is reset to NULL and
      // `last_used_step` cleared, because this is a brand-new secret with no history.
      await app.db
        .insert(mfaTotp)
        .values({
          userId: user.id,
          secretCiphertext: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretTag: encrypted.tag,
          keyVersion: encrypted.keyVersion,
          confirmedAt: null,
          lastUsedStep: null,
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: mfaTotp.userId,
          set: {
            secretCiphertext: encrypted.ciphertext,
            secretIv: encrypted.iv,
            secretTag: encrypted.tag,
            keyVersion: encrypted.keyVersion,
            confirmedAt: null,
            lastUsedStep: null,
            createdAt: new Date(),
          },
        });

      confirmAttempts.delete(user.id);

      const otpauthUri = buildOtpauthUri({ secret, email: user.email });
      const qrSvg = await renderQrSvg(otpauthUri);

      // `docs/03-auth-mfa.md` says "audit nothing yet (not confirmed)". Recording it
      // anyway, as an `mfa_challenge` tagged `stage:'enrollment'`: a successful password
      // step-up that hands out a fresh TOTP secret is exactly the sort of thing you want
      // in the log when an account turns out to have an authenticator you do not
      // recognise. The enum has no `mfa_enroll_started` and adding one would mean a
      // migration, so the nearest truthful type carries the stage in `metadata`.
      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'mfa_challenge',
        ...origin,
        metadata: { stage: 'enrollment' },
      });

      return { otpauthUri, qrSvg, secretForManualEntry: secret };
    },
  );

  // ------------------------------------------------------------------- confirm ----

  routes.post(
    '/auth/mfa/confirm',
    {
      preHandler: requireFullSession,
      schema: { body: MfaConfirmRequestSchema, response: { 200: BackupCodesResponseSchema } },
    },
    async (request) => {
      const { user, session } = authContext(request);
      const origin = requestOrigin(request);

      if (user.mfaEnabled) {
        throw new AppError(
          409,
          'MFA_ALREADY_ENABLED',
          'Multi-factor authentication is already enabled',
        );
      }

      const [pending] = await app.db
        .select()
        .from(mfaTotp)
        .where(and(eq(mfaTotp.userId, user.id), isNull(mfaTotp.confirmedAt)))
        .limit(1);

      const expired =
        pending !== undefined &&
        Date.now() - pending.createdAt.getTime() > PENDING_ENROLLMENT_TTL_MS;

      if (!pending || expired) {
        throw new AppError(
          404,
          'NO_PENDING_ENROLLMENT',
          'Start enrollment again: there is no pending setup, or it expired',
        );
      }

      const secret = decryptSecret(toEncryptedSecret(pending), key);
      const verification = verifyTotp({ secret, token: request.body.code });

      if (!verification.valid) {
        const attempts = (confirmAttempts.get(user.id) ?? 0) + 1;
        confirmAttempts.set(user.id, attempts);
        const exhausted = attempts >= MFA_CONFIRM_MAX_ATTEMPTS;
        if (exhausted) {
          // Five wrong codes means the secret in the app is not the secret in the row
          // (a half-scanned QR, the wrong account). Throwing the row away is kinder than
          // letting them keep guessing at a secret that was never going to match.
          await app.db.delete(mfaTotp).where(eq(mfaTotp.userId, user.id));
          confirmAttempts.delete(user.id);
        }
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'mfa_failed',
          ...origin,
          metadata: { stage: 'enrollment', attempts, discarded: exhausted },
        });
        throw new AppError(400, 'INVALID_CODE', 'That code is not valid', {
          attemptsRemaining: Math.max(0, MFA_CONFIRM_MAX_ATTEMPTS - attempts),
          enrollmentDiscarded: exhausted,
        });
      }

      confirmAttempts.delete(user.id);
      const now = new Date();

      // One transaction for the whole switch-on. A crash between "mfa_enabled = true" and
      // "here are your backup codes" would lock the user out of their own account with no
      // recovery path, which is the single worst outcome this route can produce.
      const backupCodes = await app.db.transaction(async (tx) => {
        await tx
          .update(mfaTotp)
          .set({ confirmedAt: now, lastUsedStep: verification.step })
          .where(eq(mfaTotp.userId, user.id));

        await tx
          .update(users)
          .set({ mfaEnabled: true, updatedAt: now })
          .where(eq(users.id, user.id));

        const codes = await replaceBackupCodes(tx, user.id, BACKUP_CODE_COUNT);

        // This session just proved the second factor by definition, so it is upgraded
        // rather than being bounced to /login/mfa on its next request.
        await tx
          .update(sessions)
          .set({
            mfaVerifiedAt: now,
            expiresAt: computeExpiry({
              createdAt: session.createdAt,
              lastSeenAt: now,
              mfaVerified: true,
            }),
          })
          .where(eq(sessions.id, session.id));

        return codes;
      });

      // Outside the transaction: every *other* device holds a session that was created
      // without a second factor. Turning MFA on and leaving those alive would mean the
      // stolen cookie you enabled MFA because of is still valid.
      const revoked = await revokeOtherSessions(app.db, user.id, session.id, now);

      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'mfa_enrolled',
        ...origin,
        metadata: { revokedSessions: revoked, backupCodes: BACKUP_CODE_COUNT },
      });

      return { backupCodes };
    },
  );

  // -------------------------------------------------------- verify (login step 2) ----

  routes.post(
    '/auth/mfa/verify',
    {
      // The only route besides /auth/me and /auth/logout that a pending session reaches —
      // it is the route whose entire job is to stop the session being pending.
      preHandler: allowPendingSession,
      schema: { body: MfaVerifyRequestSchema, response: { 200: MfaVerifyResponseSchema } },
    },
    async (request): Promise<MfaVerifyResponse> => {
      const { user, session } = authContext(request);
      const origin = requestOrigin(request);

      if (!user.mfaEnabled) {
        throw new AppError(409, 'MFA_NOT_ENABLED', 'Multi-factor authentication is not enabled');
      }
      if (session.mfaVerifiedAt !== null) {
        // Already verified. Not an error the UI needs to handle specially, but answering
        // "ok" would let a full session be used to burn backup codes for free.
        throw new AppError(409, 'MFA_NOT_ENABLED', 'This session has already been verified');
      }

      const sessionKey = sessionIdHex(session.id);
      const verdict = verifyLimiter.hit(sessionKey);
      if (!verdict.allowed) {
        // Budget exhausted: kill the pending session outright. The attacker (or the very
        // confused user) must now redo the password step, which has its own limits.
        await revokeSession(app.db, session.id);
        verifyLimiter.reset(sessionKey);
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'mfa_failed',
          ...origin,
          metadata: { reason: 'rate_limited', sessionRevoked: true },
        });
        throw rateLimited('Too many codes tried; sign in again');
      }

      const code = normaliseMfaCode(request.body.code);
      const kind = classifyMfaCode(code);
      if (kind === 'unknown') {
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'mfa_failed',
          ...origin,
          metadata: { reason: 'malformed' },
        });
        throw new AppError(
          400,
          'INVALID_CODE',
          'Enter a 6-digit code from your authenticator, or a backup code',
          { attemptsRemaining: verdict.remaining },
        );
      }

      const upgradeSession = async (now: Date): Promise<void> => {
        await app.db
          .update(sessions)
          .set({
            mfaVerifiedAt: now,
            lastSeenAt: now,
            // A pending session carries a flat 10-minute expiry; verification promotes it
            // to the normal 7-day idle window.
            expiresAt: computeExpiry({
              createdAt: session.createdAt,
              lastSeenAt: now,
              mfaVerified: true,
            }),
          })
          .where(eq(sessions.id, session.id));
        verifyLimiter.reset(sessionKey);
      };

      if (kind === 'backup') {
        const result = await consumeBackupCode(app.db, user.id, code);
        if (!result.consumed) {
          await recordAuthEvent(app.db, {
            userId: user.id,
            eventType: 'mfa_failed',
            ...origin,
            metadata: { reason: 'bad_backup_code', attemptsRemaining: verdict.remaining },
          });
          throw invalidCode();
        }

        const now = new Date();
        await upgradeSession(now);
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'backup_code_used',
          ...origin,
          metadata: { remaining: result.remaining },
        });
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'mfa_success',
          ...origin,
          metadata: { method: 'backup_code' },
        });

        return {
          status: 'ok',
          user: toPublicUser(user),
          usedBackupCode: true,
          remainingBackupCodes: result.remaining,
        };
      }

      const row = await loadConfirmedTotp(user.id);
      const secret = decryptSecret(toEncryptedSecret(row), key);
      const verification = verifyTotp({ secret, token: code });

      if (!verification.valid) {
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'mfa_failed',
          ...origin,
          metadata: { reason: 'bad_code', attemptsRemaining: verdict.remaining },
        });
        throw invalidCode();
      }

      // Replay protection. `step <= last_used_step` is the whole rule: a code is valid for
      // 90 seconds thanks to the ±1 window, and without this the same six digits could be
      // replayed by anyone who saw them during that time.
      if (row.lastUsedStep !== null && verification.step! <= row.lastUsedStep) {
        await recordAuthEvent(app.db, {
          userId: user.id,
          eventType: 'mfa_failed',
          ...origin,
          metadata: {
            reason: 'replayed_code',
            step: verification.step,
            lastUsedStep: row.lastUsedStep,
          },
        });
        throw invalidCode('That code has already been used');
      }

      const now = new Date();
      await app.db
        .update(mfaTotp)
        .set({ lastUsedStep: verification.step })
        .where(eq(mfaTotp.userId, user.id));
      await upgradeSession(now);

      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'mfa_success',
        ...origin,
        metadata: { method: 'totp', step: verification.step, delta: verification.delta },
      });

      return {
        status: 'ok',
        user: toPublicUser(user),
        remainingBackupCodes: await countRemainingBackupCodes(app.db, user.id),
      };
    },
  );

  // ------------------------------------------------- regenerate backup codes ----

  routes.post(
    '/auth/mfa/backup-codes/regenerate',
    {
      preHandler: requireFullSession,
      schema: { body: MfaStepUpRequestSchema, response: { 200: BackupCodesResponseSchema } },
    },
    async (request) => {
      const { user } = authContext(request);
      await requireStepUp(request, user, request.body.password, request.body.code);

      const backupCodes = await replaceBackupCodes(app.db, user.id, BACKUP_CODE_COUNT);

      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'backup_codes_regenerated',
        ...requestOrigin(request),
        metadata: { count: BACKUP_CODE_COUNT },
      });

      return { backupCodes };
    },
  );

  // ------------------------------------------------------------------- disable ----

  routes.post(
    '/auth/mfa/disable',
    { preHandler: requireFullSession, schema: { body: MfaStepUpRequestSchema } },
    async (request, reply) => {
      const { user } = authContext(request);
      await requireStepUp(request, user, request.body.password, request.body.code);

      const now = new Date();
      await app.db.transaction(async (tx) => {
        await tx.delete(mfaTotp).where(eq(mfaTotp.userId, user.id));
        await tx.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, user.id));
        await tx
          .update(users)
          .set({ mfaEnabled: false, updatedAt: now })
          .where(eq(users.id, user.id));
      });

      await recordAuthEvent(app.db, {
        userId: user.id,
        eventType: 'mfa_disabled',
        ...requestOrigin(request),
      });

      // Sessions are deliberately left alive. The user has just proved both factors;
      // logging them out of every device for *lowering* their own security setting would
      // be punitive, and `auth_events` records who did it and from where.
      return reply.code(204).send();
    },
  );
};
