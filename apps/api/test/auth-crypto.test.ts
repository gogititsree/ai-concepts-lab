import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  constantTimeEquals,
  decodeKeyMaterial,
  decryptSecret,
  encryptSecret,
  generateKeyMaterial,
  MFA_CURRENT_KEY_VERSION,
  MFA_IV_BYTES,
  MFA_KEY_BYTES,
  MFA_TAG_BYTES,
  MfaDecryptionError,
  MfaKeyError,
} from '../src/auth/crypto.js';
import { loadConfig } from '../src/config.js';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const KEY = randomBytes(MFA_KEY_BYTES);

const baseEnv = {
  NODE_ENV: 'test' as const,
  DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab',
};

describe('key material', () => {
  it('accepts 64 hex characters', () => {
    const hex = randomBytes(32).toString('hex');
    expect(decodeKeyMaterial(hex)).toHaveLength(MFA_KEY_BYTES);
    expect(decodeKeyMaterial(hex).toString('hex')).toBe(hex);
  });

  it('accepts 44 base64 characters, and base64url too', () => {
    const raw = randomBytes(32);
    expect(decodeKeyMaterial(raw.toString('base64')).equals(raw)).toBe(true);
    expect(decodeKeyMaterial(raw.toString('base64url')).equals(raw)).toBe(true);
  });

  it('ignores surrounding whitespace, which is what a copy-paste leaves behind', () => {
    const hex = randomBytes(32).toString('hex');
    expect(decodeKeyMaterial(`  ${hex}\n`).toString('hex')).toBe(hex);
  });

  it.each([
    ['empty', ''],
    ['too short (16 bytes of hex)', randomBytes(16).toString('hex')],
    ['too long (48 bytes of base64)', randomBytes(48).toString('base64')],
    ['not encoded at all', 'this is definitely not a key'],
  ])('rejects a key that is %s', (_label, value) => {
    expect(() => decodeKeyMaterial(value)).toThrow(MfaKeyError);
  });

  it('generateKeyMaterial produces something decodeKeyMaterial accepts', () => {
    expect(decodeKeyMaterial(generateKeyMaterial())).toHaveLength(MFA_KEY_BYTES);
  });
});

describe('config validation at boot', () => {
  it('falls back to a dev key when MFA_ENCRYPTION_KEY is unset outside production', () => {
    const config = loadConfig({ ...baseEnv });
    expect(decodeKeyMaterial(config.MFA_ENCRYPTION_KEY)).toHaveLength(MFA_KEY_BYTES);
  });

  it('refuses to boot production without one', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        SESSION_SECRET: 'a'.repeat(40),
        APP_ORIGIN: 'https://example.test',
      }),
    ).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it('refuses a key of the wrong length, whatever the environment', () => {
    // This is the failure worth catching at boot: a 16-byte key looks fine in a .env and
    // would otherwise surface as a 500 the first time someone enrolled.
    expect(() =>
      loadConfig({ ...baseEnv, MFA_ENCRYPTION_KEY: randomBytes(16).toString('hex') }),
    ).toThrow(/32 bytes/);
  });

  it('accepts a real key in either encoding', () => {
    for (const value of [randomBytes(32).toString('hex'), randomBytes(32).toString('base64')]) {
      expect(() => loadConfig({ ...baseEnv, MFA_ENCRYPTION_KEY: value })).not.toThrow();
    }
  });
});

describe('AES-256-GCM round trip', () => {
  it('encrypts and decrypts the secret', () => {
    const record = encryptSecret(SECRET, KEY);
    expect(decryptSecret(record, KEY)).toBe(SECRET);
  });

  it('produces the column shapes the schema declares', () => {
    const record = encryptSecret(SECRET, KEY);
    expect(record.iv).toHaveLength(MFA_IV_BYTES);
    expect(record.tag).toHaveLength(MFA_TAG_BYTES);
    expect(record.keyVersion).toBe(MFA_CURRENT_KEY_VERSION);
    // GCM is a stream mode: no padding, so the ciphertext is exactly the plaintext length.
    expect(record.ciphertext).toHaveLength(Buffer.byteLength(SECRET, 'utf8'));
  });

  it('never stores the plaintext', () => {
    const record = encryptSecret(SECRET, KEY);
    expect(record.ciphertext.toString('utf8')).not.toContain(SECRET);
    expect(record.ciphertext.toString('base64')).not.toContain(SECRET);
  });

  it('uses a fresh IV per encryption, so the same secret never yields the same bytes', () => {
    const a = encryptSecret(SECRET, KEY);
    const b = encryptSecret(SECRET, KEY);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
});

describe('tamper and key-mismatch detection', () => {
  it('rejects a flipped bit in the ciphertext', () => {
    const record = encryptSecret(SECRET, KEY);
    const ciphertext = Buffer.from(record.ciphertext);
    ciphertext[0] = ciphertext[0]! ^ 0x01;

    expect(() => decryptSecret({ ...record, ciphertext }, KEY)).toThrow(MfaDecryptionError);
  });

  it('rejects a flipped bit in the auth tag', () => {
    const record = encryptSecret(SECRET, KEY);
    const tag = Buffer.from(record.tag);
    tag[tag.length - 1] = tag[tag.length - 1]! ^ 0xff;

    expect(() => decryptSecret({ ...record, tag }, KEY)).toThrow(MfaDecryptionError);
  });

  it('rejects a swapped IV', () => {
    const record = encryptSecret(SECRET, KEY);
    const other = encryptSecret(SECRET, KEY);

    expect(() => decryptSecret({ ...record, iv: other.iv }, KEY)).toThrow(MfaDecryptionError);
  });

  it('rejects a truncated IV or tag rather than letting the cipher decide', () => {
    const record = encryptSecret(SECRET, KEY);
    expect(() => decryptSecret({ ...record, iv: record.iv.subarray(0, 8) }, KEY)).toThrow(
      MfaDecryptionError,
    );
    expect(() => decryptSecret({ ...record, tag: record.tag.subarray(0, 8) }, KEY)).toThrow(
      MfaDecryptionError,
    );
  });

  it('rejects the right ciphertext under the wrong key', () => {
    const record = encryptSecret(SECRET, KEY);
    expect(() => decryptSecret(record, randomBytes(MFA_KEY_BYTES))).toThrow(MfaDecryptionError);
  });

  it('refuses a key of the wrong size instead of truncating it', () => {
    expect(() => encryptSecret(SECRET, randomBytes(16))).toThrow(MfaKeyError);
  });

  it('refuses a key version it does not know how to read', () => {
    const record = encryptSecret(SECRET, KEY);
    expect(() => decryptSecret({ ...record, keyVersion: 2 }, KEY)).toThrow(/key version 2/);
  });

  it('says the same thing however it failed', () => {
    // A decryption oracle that distinguished "wrong key" from "bad tag" would be a free
    // classifier for an attacker, and no caller can act on the difference.
    const record = encryptSecret(SECRET, KEY);
    const tampered = Buffer.from(record.ciphertext);
    tampered[0] = tampered[0]! ^ 0x01;

    const wrongKey = captureMessage(() => decryptSecret(record, randomBytes(MFA_KEY_BYTES)));
    const badTag = captureMessage(() => decryptSecret({ ...record, ciphertext: tampered }, KEY));
    expect(wrongKey).toBe(badTag);
  });
});

describe('constantTimeEquals', () => {
  it('compares equal buffers as equal', () => {
    const value = randomBytes(32);
    expect(constantTimeEquals(value, Buffer.from(value))).toBe(true);
  });

  it('returns false for different lengths instead of throwing', () => {
    expect(constantTimeEquals(randomBytes(32), randomBytes(16))).toBe(false);
  });

  it('returns false for same-length differences', () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 1);
    b[31] = 2;
    expect(constantTimeEquals(a, b)).toBe(false);
  });
});

function captureMessage(fn: () => unknown): string {
  try {
    fn();
    return '(no error)';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
