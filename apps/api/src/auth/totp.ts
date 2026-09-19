import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW_STEPS,
} from '@lab/shared';
import { generateSecret, generateSync, verifySync } from 'otplib';
import QRCode from 'qrcode';

/**
 * RFC 6238 TOTP: secret generation, the provisioning URI, and verification that reports
 * *which* time step matched.
 *
 * ## The otplib 13.5 API
 *
 * v13 is a rewrite. There is no `authenticator` object any more (`otplib.authenticator`
 * is `undefined`); the package exports plain functions — `generateSecret`, `generateSync`,
 * `verifySync`, `generateURI` — plus `TOTP`/`HOTP`/`OTP` classes, with `@noble/hashes`
 * and `@scure/base` wired in as the default crypto and base32 plugins. The sync variants
 * work because the default `NobleCryptoPlugin` supports synchronous HMAC, and sync keeps
 * this module free of async plumbing that buys nothing.
 *
 * Two v13 details this file depends on:
 *
 * 1. `verifySync` returns `{ valid, delta, epoch, timeStep }`, not a boolean. `timeStep`
 *    is exactly the RFC counter `T = floor(epoch / period)` at which the token matched,
 *    which is precisely what `mfa_totp.last_used_step` needs to store. (v12 made callers
 *    compute this from `checkDelta`; v13 hands it over.)
 * 2. The window is expressed in **seconds** (`epochTolerance`), not in steps. With
 *    `period = 30`, `epochTolerance = 30` means `floor((t-30)/30) … floor((t+30)/30)`,
 *    i.e. exactly ±1 step at every instant — the ±1 the design doc asks for.
 *
 * otplib also has an `afterTimeStep` option that would do the replay check inside
 * `verifySync`. It is *not* used: it throws when the stored step is ahead of the current
 * one (a clock that went backwards would turn a login into a 500), and keeping the
 * comparison in the route makes the rule visible next to the `UPDATE` that advances it.
 */

export { TOTP_ALGORITHM, TOTP_DIGITS, TOTP_ISSUER, TOTP_PERIOD_SECONDS, TOTP_WINDOW_STEPS };

/**
 * 20 bytes = 160 bits, the HMAC-SHA1 block-aligned size RFC 4226 recommends, and what
 * every authenticator app expects. Base32-encoded, it is 32 characters.
 */
export const TOTP_SECRET_BYTES = 20;

/** A fresh base32 secret, ready to be encrypted and to be shown once for manual entry. */
export function generateTotpSecret(): string {
  return generateSecret({ length: TOTP_SECRET_BYTES });
}

/**
 * The RFC 6238 time step for an instant: `T = floor(unixSeconds / 30)`.
 *
 * Exported because it is the unit `mfa_totp.last_used_step` is measured in, and because a
 * test that wants "a code from two steps ago" needs the same arithmetic the server uses.
 */
export function currentStep(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** The instant at which a given step begins — the inverse of `currentStep`. */
export function stepToDate(step: number): Date {
  return new Date(step * TOTP_PERIOD_SECONDS * 1000);
}

/**
 * Builds the `otpauth://` provisioning URI.
 *
 * Hand-built rather than via otplib's `generateURI`, for two reasons. First, `generateURI`
 * composes the label as `<issuer>:<label>`, so passing the documented label
 * `AI Concepts Lab:user@example.com` would double the issuer. Second, it *omits*
 * parameters that equal its defaults, so the URI would carry no `algorithm`, `digits` or
 * `period` — legal (readers are supposed to assume SHA1/6/30) but the design doc spells
 * them out, and an explicit URI is far easier to debug against an app that guesses
 * differently.
 *
 * Encoding note: `encodeURIComponent` is used for the path label rather than letting
 * `URL` do it, because `URL` leaves `:` and `@` unescaped in a path segment, and the
 * Key URI format wants the colon between issuer and account to be the *only* literal one.
 */
export function buildOtpauthUri(input: { secret: string; email: string; issuer?: string }): string {
  const issuer = input.issuer ?? TOTP_ISSUER;
  const label = `${issuer}:${input.email}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/**
 * Renders the provisioning URI as inline SVG, server-side.
 *
 * Doing it here rather than shipping a QR library to the browser keeps the secret out of
 * one more place: the SPA receives a picture and a string it displays, and never has to
 * parse or re-encode the secret itself.
 */
export async function renderQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

/** The code for a given secret at a given instant. Used by tests and by the docs' node snippet. */
export function generateTotp(secret: string, now: Date = new Date()): string {
  return generateSync({
    secret,
    epoch: Math.floor(now.getTime() / 1000),
    algorithm: 'sha1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  });
}

export interface TotpVerification {
  valid: boolean;
  /** The RFC counter the token matched at. Only set when `valid`. */
  step?: number;
  /** Offset in steps from "now": -1, 0 or +1. Only set when `valid`. */
  delta?: number;
}

export interface VerifyTotpInput {
  /** Base32 secret, decrypted. */
  secret: string;
  /** The code as typed; whitespace is stripped here. */
  token: string;
  now?: Date;
  /** Steps of tolerance either side. Defaults to the documented ±1. */
  windowSteps?: number;
}

/**
 * Verifies a code and, on success, reports the step it matched.
 *
 * The caller compares that step with `mfa_totp.last_used_step` and refuses anything less
 * than or equal to it. That check is what makes a code single-use: without it, a code
 * shoulder-surfed (or read off a proxy log) stays valid for up to 90 seconds, which is
 * plenty for an attacker who is already watching.
 */
export function verifyTotp(input: VerifyTotpInput): TotpVerification {
  const token = input.token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return { valid: false };

  const windowSteps = input.windowSteps ?? TOTP_WINDOW_STEPS;
  const now = input.now ?? new Date();

  const result = verifySync({
    secret: input.secret,
    token,
    epoch: Math.floor(now.getTime() / 1000),
    algorithm: 'sha1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    // Seconds, not steps. period * window is the ±N-step window the doc specifies.
    epochTolerance: windowSteps * TOTP_PERIOD_SECONDS,
  });

  if (!result.valid) return { valid: false };

  // `verifySync` is typed for both strategies, and only the TOTP result carries
  // `timeStep` (HOTP counts with an explicit counter instead). We never pass
  // `strategy: 'hotp'`, so this narrow always succeeds — but writing it as an `in` check
  // rather than a cast means an otplib release that stopped reporting the step would be
  // a compile error here instead of a silently `undefined` `last_used_step`, which would
  // disable replay protection without failing a single test.
  if (!('timeStep' in result)) {
    throw new Error('otplib returned a TOTP verification without a time step');
  }
  return { valid: true, step: result.timeStep, delta: result.delta };
}
