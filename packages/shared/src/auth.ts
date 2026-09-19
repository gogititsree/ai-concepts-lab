import { z } from 'zod';

import { isCommonPassword } from './common-passwords.js';

/**
 * Contracts for `/api/v1/auth`, transcribed from the table in `docs/01-architecture.md`
 * and the flows in `docs/03-auth-mfa.md`.
 *
 * These schemas are the *only* definition of the auth wire format: Fastify validates
 * requests and serialises responses through them, and the web client parses responses
 * with the same objects. A field that is not in a response schema cannot be sent — which
 * is how `users.password_hash` is kept out of every payload structurally rather than by
 * remembering to omit it.
 *
 * The MFA request/response shapes live here too where M5 needs them (the `mfa_required`
 * login branch); the rest arrive with M6.
 */

// ------------------------------------------------------------- password policy ----

/** NIST SP 800-63B: length is the control that matters. */
export const PASSWORD_MIN = 12;
/**
 * An upper bound exists only to stop someone feeding a megabyte into argon2id (a cheap
 * DoS); 128 is far above any real passphrase.
 */
export const PASSWORD_MAX = 128;

export { isCommonPassword, COMMON_PASSWORDS } from './common-passwords.js';

/**
 * No composition rules on purpose: no "must contain a symbol", no Unicode stripping.
 * The only two gates are length and the bundled common-password list.
 */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`)
  .refine((value) => !isCommonPassword(value), {
    message: 'Password is too common; choose something less guessable',
  });

/**
 * `.trim()` before `.email()` so a copy-pasted address with a trailing space is accepted
 * and then stored in its cleaned form; the column is `citext`, so case is already handled
 * by the database.
 */
export const EmailSchema = z.string().trim().min(3).max(254).email('Must be a valid email address');

export const DisplayNameSchema = z.string().trim().min(1).max(80);

// ------------------------------------------------------------------ primitives ----

/** ISO-8601 with a timezone; every timestamp on the wire is `Date.toISOString()`. */
const IsoTimestampSchema = z.string().datetime();

/**
 * The public projection of a user. Note what is absent: `passwordHash`,
 * `failedLoginCount`, `lockedUntil`. Because Zod objects strip unknown keys during
 * response serialisation, handing this schema a full database row cannot leak them.
 */
export const PublicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  mfaEnabled: z.boolean(),
  createdAt: IsoTimestampSchema,
});

export type PublicUser = z.infer<typeof PublicUserSchema>;

/** Every error body in the API: `{ error: { code, message, details? } }`. */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * The closed set of codes the auth surface emits. Kept as a list (rather than free-form
 * strings) so the web app can exhaustively switch on it — `MFA_REQUIRED` in particular
 * drives a redirect to `/login/mfa` rather than to `/login`.
 */
export const AuthErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'INVALID_CREDENTIALS',
  'LOCKED',
  'FORBIDDEN',
  'CSRF_REJECTED',
  'EMAIL_TAKEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  // --- M6 ---
  /** A TOTP or backup code that did not verify (or was a replay of one that already did). */
  'INVALID_CODE',
  /** Enrollment attempted on an account that already has a confirmed second factor. */
  'MFA_ALREADY_ENABLED',
  /** Disable/regenerate attempted on an account with no second factor. */
  'MFA_NOT_ENABLED',
  /** Confirm attempted with no pending enrollment (never started, expired, or burnt). */
  'NO_PENDING_ENROLLMENT',
]);

export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;

// -------------------------------------------------------------------- register ----

export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema,
});

export const RegisterResponseSchema = z.object({ user: PublicUserSchema });

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

// ----------------------------------------------------------------------- login ----

/**
 * Login validates only that the field is a non-empty string, deliberately *not* against
 * `PasswordSchema`. Running the policy on login would tell an attacker "that password is
 * too short to be anyone's password here" before any credential check, and would lock out
 * users whose password predates a policy change.
 */
export const LoginRequestSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(PASSWORD_MAX),
});

export const LoginOkResponseSchema = z.object({
  status: z.literal('ok'),
  user: PublicUserSchema,
});

/**
 * Login step 1 succeeded but the account has TOTP enabled: the cookie now holds a
 * *pending* session (10-minute lifetime, `mfa_verified_at IS NULL`) and the client must
 * post to `/auth/mfa/verify`. Unreachable until M6 enables MFA, but the branch is typed
 * from the start so M6 adds a handler, not a contract change.
 */
export const LoginMfaRequiredResponseSchema = z.object({
  status: z.literal('mfa_required'),
});

export const LoginResponseSchema = z.discriminatedUnion('status', [
  LoginOkResponseSchema,
  LoginMfaRequiredResponseSchema,
]);

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginOkResponse = z.infer<typeof LoginOkResponseSchema>;
export type LoginMfaRequiredResponse = z.infer<typeof LoginMfaRequiredResponseSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// -------------------------------------------------------------------------- me ----

export const SessionStateSchema = z.object({
  /** False on a pending-MFA session; the frontend routes those to `/login/mfa`. */
  mfaVerified: z.boolean(),
  expiresAt: IsoTimestampSchema,
});

export const MeResponseSchema = z.object({
  user: PublicUserSchema,
  session: SessionStateSchema,
  /**
   * Unused backup codes left, or `null` when MFA is off. Lives on `/auth/me` rather than
   * on a dedicated endpoint so the "you have 1 backup code left" banner costs no extra
   * round trip; the count is only queried when `user.mfaEnabled` is set.
   */
  remainingBackupCodes: z.number().int().min(0).nullable().default(null),
});

export type SessionState = z.infer<typeof SessionStateSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ------------------------------------------------------------- change password ----

/**
 * Step-up: the current password is required even though the caller already holds a valid
 * session, so a stolen cookie alone cannot lock the owner out of their own account.
 */
export const PasswordChangeRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX),
    newPassword: PasswordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });

export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>;

// ---------------------------------------------------------------------sessions ----

/** First 8 hex characters of `sha256(token)` — enough to identify, useless as a token. */
export const SESSION_ID_PREFIX_LENGTH = 8;

export const SessionSummarySchema = z.object({
  /**
   * The *prefix* of the stored session id. Full ids are not returned: the id is the
   * hash of a live credential, and a list endpoint has no reason to hand it out.
   */
  id: z.string().regex(/^[0-9a-f]{8}$/),
  createdAt: IsoTimestampSchema,
  lastSeenAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** True for the session making the request; the UI labels it "this device". */
  current: z.boolean(),
});

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});

/**
 * `DELETE /auth/sessions/:id` accepts either the 8-character prefix shown by the list
 * endpoint or the full 64-character hex id, so a client that later gains access to full
 * ids (an admin view, say) needs no new route.
 */
export const SessionIdParamSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9a-f]{8}$|^[0-9a-f]{64}$/, 'Must be an 8- or 64-character lowercase hex id'),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type SessionIdParam = z.infer<typeof SessionIdParamSchema>;

// ------------------------------------------------------------------- MFA (M6) ----

/**
 * TOTP parameters, per `docs/03-auth-mfa.md`. They are here rather than in the API
 * because the enrollment UI prints them next to the manual-entry secret, and a value that
 * is displayed in one place and enforced in another is a value that will drift.
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ALGORITHM = 'SHA1';
/** ±1 step of tolerance: one period of clock skew or typing delay either way. */
export const TOTP_WINDOW_STEPS = 1;
/** The `issuer` in the otpauth URI and the prefix of its label. */
export const TOTP_ISSUER = 'AI Concepts Lab';

/** How many single-use backup codes an enrollment (or a regeneration) mints. */
export const BACKUP_CODE_COUNT = 10;
/** At or below this many codes left, the UI nags. */
export const BACKUP_CODE_LOW_WATERMARK = 2;

/** A six-digit TOTP as typed by a human; spaces are stripped before this is applied. */
export const TotpCodeSchema = z.string().regex(/^\d{6}$/, 'Must be a 6-digit code');

/**
 * `xxxxx-xxxxx` in lowercase Crockford base32 (no `i`, `l`, `o`, `u`). The schema is
 * deliberately strict — `normaliseMfaCode` below is what turns human input into this
 * shape, so the wire format stays one thing.
 */
export const BACKUP_CODE_PATTERN = /^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/;
export const BackupCodeSchema = z
  .string()
  .regex(BACKUP_CODE_PATTERN, 'Must be a backup code in the form xxxxx-xxxxx');

/**
 * Canonicalises whatever the user typed into either a 6-digit TOTP or a backup code.
 *
 * Shared with the browser so the MFA form can tell the two apart *before* it posts (to
 * label the field and to disable the button), using exactly the rules the server applies.
 * Crockford's letter aliases are folded here — `O`→`0`, `I`/`L`→`1` — because those are
 * the characters people actually mistype off a printed sheet.
 */
export function normaliseMfaCode(input: string): string {
  const stripped = input.replace(/[\s_]+/g, '').toLowerCase();
  if (/^\d{6}$/.test(stripped)) return stripped;

  const folded = stripped
    .replace(/-/g, '')
    .replace(/o/g, '0')
    .replace(/[il]/g, '1')
    .replace(/u/g, 'v');
  if (/^[0-9a-hjkmnp-tv-z]{10}$/.test(folded)) {
    return `${folded.slice(0, 5)}-${folded.slice(5)}`;
  }
  return stripped;
}

export type MfaCodeKind = 'totp' | 'backup' | 'unknown';

export function classifyMfaCode(input: string): MfaCodeKind {
  const code = normaliseMfaCode(input);
  if (/^\d{6}$/.test(code)) return 'totp';
  if (BACKUP_CODE_PATTERN.test(code)) return 'backup';
  return 'unknown';
}

// -- enroll --

/** Step-up: a valid session is not enough to bolt a second factor onto an account. */
export const MfaEnrollRequestSchema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX),
});

export const MfaEnrollResponseSchema = z.object({
  /** `otpauth://totp/...` — what the QR encodes. */
  otpauthUri: z.string(),
  /** Server-rendered `<svg>` markup for that URI. */
  qrSvg: z.string(),
  /**
   * The base32 secret, for typing into an app that cannot scan. Returned **only** by this
   * route and never again: after confirmation the only copy is encrypted in the database.
   */
  secretForManualEntry: z.string(),
});

export type MfaEnrollRequest = z.infer<typeof MfaEnrollRequestSchema>;
export type MfaEnrollResponse = z.infer<typeof MfaEnrollResponseSchema>;

// -- confirm --

export const MfaConfirmRequestSchema = z.object({ code: TotpCodeSchema });

/**
 * The plaintext backup codes, shown exactly once. The UI makes the user acknowledge that
 * they have saved them before it will move on, because there is no second chance.
 */
export const BackupCodesResponseSchema = z.object({
  backupCodes: z.array(z.string()).length(BACKUP_CODE_COUNT),
});

export type MfaConfirmRequest = z.infer<typeof MfaConfirmRequestSchema>;
export type BackupCodesResponse = z.infer<typeof BackupCodesResponseSchema>;

// -- verify (login step 2) --

/**
 * One field for both factors. Which one it is, is a property of the string, not of a
 * radio button the user has to get right while locked out of their account.
 */
export const MfaVerifyRequestSchema = z.object({
  code: z.string().trim().min(1).max(32),
});

export const MfaVerifyResponseSchema = z.object({
  status: z.literal('ok'),
  user: PublicUserSchema,
  /** Present and true when a backup code was spent rather than a TOTP. */
  usedBackupCode: z.boolean().optional(),
  /** How many unused backup codes are left; drives the "you are running out" nag. */
  remainingBackupCodes: z.number().int().min(0).optional(),
});

export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;
export type MfaVerifyResponse = z.infer<typeof MfaVerifyResponseSchema>;

// -- regenerate / disable --

/**
 * Both routes need the password *and* a current second factor: whoever is turning MFA off
 * or invalidating the recovery codes must be holding the phone, not just the cookie.
 */
export const MfaStepUpRequestSchema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX),
  code: z.string().trim().min(1).max(32),
});

export type MfaStepUpRequest = z.infer<typeof MfaStepUpRequestSchema>;
