import { BACKUP_CODE_COUNT, classifyMfaCode, normaliseMfaCode } from '@lab/shared';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import {
  canonicaliseBackupCode,
  CROCKFORD_ALPHABET,
  generateBackupCode,
  generateBackupCodes,
  hashBackupCode,
  isBackupCodeFormat,
} from '../src/auth/backupCodes.js';

/**
 * The pure half of backup codes: shape, entropy, canonicalisation and hashing. The
 * stateful half (single use, remaining count) needs a database and lives in
 * `test/integration/mfa.test.ts`.
 *
 * argon2id at 64 MiB is slow on purpose, so this file hashes a handful of codes rather
 * than all ten — the "all ten get hashed" behaviour is proven by the integration suite
 * against real rows.
 */

describe('format', () => {
  it('is xxxxx-xxxxx from the Crockford alphabet', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateBackupCode();
      expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
      expect(isBackupCodeFormat(code)).toBe(true);
    }
  });

  it('never contains the characters Crockford drops', () => {
    // i, l, o and u: the ones people misread as 1, 1, 0 and each other off a printed sheet.
    const sample = Array.from({ length: 200 }, generateBackupCode).join('');
    for (const excluded of ['i', 'l', 'o', 'u']) {
      expect(sample).not.toContain(excluded);
    }
  });

  it('uses an alphabet that divides 256, so `byte % 32` is unbiased', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(256 % CROCKFORD_ALPHABET.length).toBe(0);
  });

  it('draws roughly uniformly across the alphabet', () => {
    // 2000 codes = 20 000 symbols over 32 symbols -> ~625 each. A generator that silently
    // favoured the low end (the classic modulo-bias bug) would blow through this bound.
    const symbols = Array.from({ length: 2000 }, generateBackupCode).join('').replace(/-/g, '');
    const counts = new Map<string, number>();
    for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);

    expect(counts.size).toBe(CROCKFORD_ALPHABET.length);
    const expected = symbols.length / CROCKFORD_ALPHABET.length;
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.6);
      expect(count).toBeLessThan(expected * 1.4);
    }
  });
});

describe('a generated set', () => {
  it('is ten distinct codes', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
  });

  it('is distinct across sets too', () => {
    const a = generateBackupCodes();
    const b = generateBackupCodes();
    expect(a.filter((code) => b.includes(code))).toEqual([]);
  });

  it('honours an explicit count', () => {
    expect(generateBackupCodes(3)).toHaveLength(3);
  });
});

describe('canonicalisation', () => {
  it('accepts the canonical form unchanged', () => {
    const code = generateBackupCode();
    expect(canonicaliseBackupCode(code)).toBe(code);
  });

  it.each([
    ['uppercase', (code: string) => code.toUpperCase()],
    ['without the hyphen', (code: string) => code.replace('-', '')],
    ['with a space instead of the hyphen', (code: string) => code.replace('-', ' ')],
    ['with surrounding whitespace', (code: string) => `  ${code}\n`],
  ])('accepts a code %s', (_label, mangle) => {
    const code = generateBackupCode();
    expect(canonicaliseBackupCode(mangle(code))).toBe(code);
  });

  it('folds the characters Crockford treats as aliases', () => {
    // A sheet prints `0`; the user types `O`. Both must reach the same hash.
    expect(canonicaliseBackupCode('O123I-4567L')).toBe('01231-45671');
  });

  it('rejects anything that is not a backup code', () => {
    for (const input of ['', '123456', 'abc', 'zzzzz-zzzzzz', '!!!!!-!!!!!']) {
      expect(canonicaliseBackupCode(input)).toBeNull();
    }
  });
});

describe('classification (shared with the browser)', () => {
  it('tells a TOTP from a backup code', () => {
    expect(classifyMfaCode('123456')).toBe('totp');
    expect(classifyMfaCode('123 456')).toBe('totp');
    expect(classifyMfaCode(generateBackupCode())).toBe('backup');
    expect(classifyMfaCode(generateBackupCode().toUpperCase())).toBe('backup');
    expect(classifyMfaCode('12345')).toBe('unknown');
    expect(classifyMfaCode('')).toBe('unknown');
  });

  it('normalises a TOTP without mangling it', () => {
    expect(normaliseMfaCode(' 123 456 ')).toBe('123456');
  });
});

describe('hashing', () => {
  it('stores an argon2id hash, not the code', async () => {
    const code = generateBackupCode();
    const hash = await hashBackupCode(code);

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain(code);
    // Same parameters as passwords, so there is one cost profile to reason about.
    expect(hash).toContain('m=65536,p=1,t=3');
  });

  it('verifies the right code and rejects a near miss', async () => {
    const code = generateBackupCode();
    const hash = await hashBackupCode(code);

    await expect(argon2.verify(hash, code)).resolves.toBe(true);
    await expect(argon2.verify(hash, generateBackupCode())).resolves.toBe(false);
    // Case and punctuation are folded *before* hashing, so the canonical form is the only
    // thing that ever meets argon2 — the raw uppercase string must not verify.
    await expect(argon2.verify(hash, code.toUpperCase())).resolves.toBe(false);
    await expect(argon2.verify(hash, canonicaliseBackupCode(code.toUpperCase())!)).resolves.toBe(
      true,
    );
  });

  it('salts, so the same code hashes differently twice', async () => {
    const code = generateBackupCode();
    expect(await hashBackupCode(code)).not.toBe(await hashBackupCode(code));
  });
});
