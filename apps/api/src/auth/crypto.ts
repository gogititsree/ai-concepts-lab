import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encryption at rest for the TOTP shared secret (`docs/03-auth-mfa.md` → "TOTP secret at
 * rest").
 *
 * The threat this closes is narrow and specific: **a database dump must not let anyone
 * mint valid codes.** A TOTP secret is a symmetric key — whoever holds it *is* the second
 * factor forever — so unlike a password it cannot be hashed; the server has to be able to
 * read it back. That leaves authenticated encryption with a key kept somewhere the
 * database is not, which here means `MFA_ENCRYPTION_KEY` in the environment.
 *
 * What this does **not** protect against, consciously: an attacker with both the dump and
 * the environment. Splitting those two is the whole of the benefit, and it is real —
 * backups, replicas and `pg_dump` files travel far more widely than process environments.
 *
 * Choices worth naming:
 * - **AES-256-GCM**, not CBC or CTR: GCM authenticates. A flipped bit in `secret_ciphertext`
 *   must fail loudly rather than decrypt to a different secret that then rejects every
 *   code the user types for reasons nobody can diagnose.
 * - **A fresh 12-byte IV per row.** 96 bits is GCM's native nonce size (anything else
 *   costs an extra GHASH pass), and reusing a nonce under one key is the catastrophic
 *   failure mode for GCM, so it is generated, never derived.
 * - **`key_version` stored alongside.** Rotation is then a matter of decrypting with the
 *   old key and re-encrypting with the new one, row by row, rather than a flag day.
 *
 * This module deliberately knows nothing about Fastify, Drizzle or `config.ts` — it takes
 * a key and returns bytes — so `config.ts` can import `decodeKeyMaterial` to validate the
 * environment at boot without a circular import.
 */

/** AES-256. */
export const MFA_KEY_BYTES = 32;
/** GCM's native nonce length. */
export const MFA_IV_BYTES = 12;
/** Full-length GCM tag. */
export const MFA_TAG_BYTES = 16;
/** The only key generation that exists so far; written into every row. */
export const MFA_CURRENT_KEY_VERSION = 1;

const ALGORITHM = 'aes-256-gcm';

/** Thrown when a secret cannot be recovered: wrong key, tampered ciphertext, bad IV. */
export class MfaDecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MfaDecryptionError';
  }
}

/** Thrown by `decodeKeyMaterial` for anything that is not 32 usable bytes. */
export class MfaKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MfaKeyError';
  }
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Turns the `MFA_ENCRYPTION_KEY` environment value into 32 raw bytes.
 *
 * Both hex and base64/base64url are accepted because both are what people paste: `openssl
 * rand -hex 32` produces one, `node -e "...base64"` and most secret managers produce the
 * other. Hex is detected by shape (exactly 64 hex characters) and everything else is
 * tried as base64 — the ambiguity is harmless, since a 64-character hex string decoded as
 * base64 would be 48 bytes and fail the length check anyway.
 *
 * The length check is the point of this function: a short key silently truncated (or
 * padded) is the classic way a "256-bit" key turns out to be 12 bytes of entropy, and the
 * only moment to catch it is at boot.
 */
export function decodeKeyMaterial(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new MfaKeyError('is empty');

  const decoded = HEX_64.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');

  if (decoded.length !== MFA_KEY_BYTES) {
    throw new MfaKeyError(
      `must decode to exactly ${MFA_KEY_BYTES} bytes (got ${decoded.length}); ` +
        'provide 64 hex characters or 44 base64 characters',
    );
  }
  return decoded;
}

/** Convenience for scripts and `pnpm setup:env`: a fresh key as base64. */
export function generateKeyMaterial(): string {
  return randomBytes(MFA_KEY_BYTES).toString('base64');
}

/** The three columns of `mfa_totp` that together hold one encrypted secret. */
export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  assertKey(key);
  const iv = randomBytes(MFA_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: MFA_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion: MFA_CURRENT_KEY_VERSION };
}

/**
 * Recovers the base32 secret, or throws.
 *
 * Every failure path is one error type with one message. A decryption oracle that
 * distinguished "wrong key" from "bad tag" from "wrong length" would be handing an
 * attacker a free classifier, and there is nothing a caller could usefully do with the
 * distinction anyway: all three mean "this row is unusable, tell the user to re-enroll".
 */
export function decryptSecret(record: EncryptedSecret, key: Buffer): string {
  assertKey(key);
  if (record.iv.length !== MFA_IV_BYTES) {
    throw new MfaDecryptionError('Stored MFA secret is unusable');
  }
  if (record.tag.length !== MFA_TAG_BYTES) {
    throw new MfaDecryptionError('Stored MFA secret is unusable');
  }
  if (record.keyVersion !== MFA_CURRENT_KEY_VERSION) {
    throw new MfaDecryptionError(
      `Stored MFA secret uses key version ${record.keyVersion}, which this build cannot read`,
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, record.iv, {
      authTagLength: MFA_TAG_BYTES,
    });
    decipher.setAuthTag(record.tag);
    // `final()` is where GCM verifies the tag, so a tampered ciphertext throws *here* and
    // never reaches the caller as a plausible-looking string.
    return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new MfaDecryptionError('Stored MFA secret is unusable', { cause: error });
  }
}

/**
 * Constant-time equality for two buffers of possibly different lengths.
 *
 * `timingSafeEqual` throws when the lengths differ, which would itself leak the length
 * through an exception; comparing lengths first and then comparing bytes is the standard
 * shape, and length is not the secret here.
 */
export function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function assertKey(key: Buffer): void {
  if (key.length !== MFA_KEY_BYTES) {
    throw new MfaKeyError(`Encryption key must be ${MFA_KEY_BYTES} bytes, got ${key.length}`);
  }
}
