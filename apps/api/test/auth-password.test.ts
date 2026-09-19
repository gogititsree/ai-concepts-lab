import { PASSWORD_MAX, PASSWORD_MIN, PasswordSchema, isCommonPassword } from '@lab/shared';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import {
  ARGON2_OPTIONS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  needsRehash,
  verifyDummyPassword,
  verifyPassword,
} from '../src/auth/password.js';

const GOOD_PASSWORD = 'correct horse battery staple';

describe('password hashing', () => {
  it('round-trips a password and rejects the wrong one', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);

    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(hash, GOOD_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(hash, 'correct horse battery stapl')).resolves.toBe(false);
  });

  it('salts every hash, so identical passwords do not collide', async () => {
    const [a, b] = await Promise.all([hashPassword(GOOD_PASSWORD), hashPassword(GOOD_PASSWORD)]);
    // Equal hashes would mean an unsalted scheme: one rainbow table would break every
    // account that shares a password.
    expect(a).not.toBe(b);
  });

  it('embeds the documented argon2id parameters in the encoded hash', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(hash).toContain(`m=${ARGON2_OPTIONS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2_OPTIONS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2_OPTIONS.parallelism}`);
  });

  it('returns false instead of throwing on a corrupt stored hash', async () => {
    await expect(verifyPassword('not-an-argon2-hash', GOOD_PASSWORD)).resolves.toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with the current parameters', async () => {
    expect(needsRehash(await hashPassword(GOOD_PASSWORD))).toBe(false);
  });

  it('is true for a hash made with weaker parameters', async () => {
    // What a hash from an older deployment looks like: 19 MiB instead of 64.
    const weak = await argon2.hash(GOOD_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    expect(needsRehash(weak)).toBe(true);
  });

  it('is true for an unparseable hash, so the next login replaces it', () => {
    expect(needsRehash('garbage')).toBe(true);
  });
});

describe('the dummy hash used to normalise failure timing', () => {
  it('is a valid argon2id hash with the current parameters', () => {
    expect(DUMMY_PASSWORD_HASH.startsWith('$argon2id$')).toBe(true);
    // If this drifts, the "unknown email" branch of login stops costing what a real
    // verification costs and re-opens the timing side channel.
    expect(DUMMY_PASSWORD_HASH).toContain(`m=${ARGON2_OPTIONS.memoryCost}`);
    expect(DUMMY_PASSWORD_HASH).toContain(`t=${ARGON2_OPTIONS.timeCost}`);
    expect(DUMMY_PASSWORD_HASH).toContain(`p=${ARGON2_OPTIONS.parallelism}`);
  });

  it('always reports failure', async () => {
    await expect(verifyDummyPassword('anything at all')).resolves.toBe(false);
  });
});

describe('password policy', () => {
  it('accepts a long passphrase with no special characters', () => {
    expect(PasswordSchema.safeParse(GOOD_PASSWORD).success).toBe(true);
  });

  it('rejects anything shorter than the minimum', () => {
    const result = PasswordSchema.safeParse('a'.repeat(PASSWORD_MIN - 1));
    expect(result.success).toBe(false);
  });

  it('rejects anything longer than the maximum', () => {
    expect(PasswordSchema.safeParse('a'.repeat(PASSWORD_MAX + 1)).success).toBe(false);
  });

  it('accepts Unicode, including emoji and non-Latin scripts', () => {
    expect(PasswordSchema.safeParse('これは日本語のパスワードです').success).toBe(true);
    expect(PasswordSchema.safeParse('🔐🔐🔐 keeps the door shut').success).toBe(true);
  });

  it('rejects passwords on the bundled common list', () => {
    // Long enough to pass the length gate, and still one of the first guesses anyone
    // would make — exactly the case the list exists for.
    const result = PasswordSchema.safeParse('password1234');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/too common/i);
  });

  it('matches the common list case-insensitively', () => {
    expect(isCommonPassword('PassWord1234')).toBe(true);
    expect(isCommonPassword('  qwerty123456  ')).toBe(true);
    expect(isCommonPassword(GOOD_PASSWORD)).toBe(false);
  });
});
