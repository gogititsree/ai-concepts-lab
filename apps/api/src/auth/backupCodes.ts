import { randomBytes } from 'node:crypto';

import { BACKUP_CODE_COUNT, BACKUP_CODE_PATTERN, normaliseMfaCode } from '@lab/shared';
import argon2 from 'argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db, DbLike } from '../db/client.js';
import { mfaBackupCodes } from '../db/schema.js';
import { ARGON2_OPTIONS } from './password.js';

/**
 * Backup codes: the way back in when the phone is lost.
 *
 * Ten codes, `xxxxx-xxxxx`, shown once, argon2id-hashed, single use — the contract from
 * `docs/03-auth-mfa.md`. Three decisions are worth their reasoning:
 *
 * **Why hash them at all.** A backup code is a password that bypasses the second factor.
 * Storing them in plaintext would mean a database dump defeats MFA for every user, which
 * is exactly the outcome encrypting the TOTP secret is there to prevent. Same argon2id
 * parameters as passwords, so there is one cost profile to reason about.
 *
 * **Why Crockford base32.** No `i`, `l`, `o` or `u`: the first three are the characters
 * people confuse with `1` and `0` when copying from a printed sheet, and dropping `u`
 * keeps the alphabet from spelling things. `normaliseMfaCode` in `@lab/shared` folds the
 * confusable characters back, so typing `O` where the sheet says `0` still works.
 *
 * **Why 50 bits.** Ten characters from a 32-symbol alphabet. The codes are only reachable
 * through `/auth/mfa/verify`, which is rate-limited to 5 attempts per 15 minutes per
 * session, so online guessing is hopeless long before the entropy matters; 50 bits then
 * also covers the offline case if the hashes ever leak.
 */

/** Crockford's base32 alphabet, lowercased. 32 symbols — see `randomSymbol` on the bias. */
export const CROCKFORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Characters per group; two groups joined by a hyphen. */
const GROUP_LENGTH = 5;

export { BACKUP_CODE_COUNT };

/**
 * One uniformly random symbol.
 *
 * `byte % 32` is bias-free here *only* because 32 divides 256 exactly — with a 33-symbol
 * alphabet this would quietly favour the first 25 characters. The assertion below is
 * cheap insurance against someone editing the alphabet later.
 */
function randomSymbols(count: number): string {
  if (256 % CROCKFORD_ALPHABET.length !== 0) {
    throw new Error('Alphabet length must divide 256 for unbiased modulo sampling');
  }
  const bytes = randomBytes(count);
  let out = '';
  for (const byte of bytes) {
    out += CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/** A single code in canonical form, e.g. `9k3xq-m7b2t`. */
export function generateBackupCode(): string {
  return `${randomSymbols(GROUP_LENGTH)}-${randomSymbols(GROUP_LENGTH)}`;
}

/**
 * `count` distinct codes.
 *
 * Collisions are astronomically unlikely (50 bits, ten draws) but the loop is two lines
 * and a duplicate would silently reduce the set to nine usable codes.
 */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateBackupCode());
  return [...codes];
}

/** True when the string is a backup code in canonical form. */
export function isBackupCodeFormat(value: string): boolean {
  return BACKUP_CODE_PATTERN.test(value);
}

/**
 * Canonicalises user input, or returns null when it is not a backup code at all.
 *
 * Hashing happens against the canonical form only, so `9K3XQM7B2T`, `9k3xq-m7b2t` and
 * `9k3xq m7b2t` are one code rather than three misses.
 */
export function canonicaliseBackupCode(input: string): string | null {
  const normalised = normaliseMfaCode(input);
  return isBackupCodeFormat(normalised) ? normalised : null;
}

export function hashBackupCode(code: string): Promise<string> {
  return argon2.hash(code, ARGON2_OPTIONS);
}

/**
 * Replaces a user's whole set of codes: delete every existing row, insert `count` fresh
 * hashes, return the plaintext.
 *
 * "Delete every existing row", not "delete the unused ones": a used row's only remaining
 * value would be to say "this code was spent", and `auth_events` already records that
 * with a timestamp and an IP. Keeping spent hashes around would also let a regenerate
 * silently re-issue a code that had already been burnt.
 *
 * The caller wraps this in a transaction where it matters (enrollment confirmation), so
 * this function takes a `Db` and does not open one of its own.
 */
export async function replaceBackupCodes(
  db: DbLike,
  userId: string,
  count: number = BACKUP_CODE_COUNT,
): Promise<string[]> {
  const codes = generateBackupCodes(count);
  // Sequential, not `Promise.all`: argon2id at 64 MiB × 10 in parallel is 640 MiB of
  // resident memory on a free-tier container, for an operation that happens twice in an
  // account's lifetime.
  const hashes: string[] = [];
  for (const code of codes) hashes.push(await hashBackupCode(code));

  await db.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
  await db.insert(mfaBackupCodes).values(hashes.map((codeHash) => ({ userId, codeHash })));

  return codes;
}

/** How many unused codes the user has left. Drives the "you are running low" nag. */
export async function countRemainingBackupCodes(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mfaBackupCodes)
    .where(and(eq(mfaBackupCodes.userId, userId), isNull(mfaBackupCodes.usedAt)));
  return rows[0]?.count ?? 0;
}

export interface ConsumeBackupCodeResult {
  consumed: boolean;
  /** Unused codes left *after* this call. */
  remaining: number;
}

/**
 * Verifies a backup code and marks it used, atomically enough.
 *
 * The scan is linear over at most ten unused rows: argon2 hashes are salted, so there is
 * no index to look the code up by — the hash of a candidate does not equal the stored
 * hash of the same code. Ten verifications at ~60 ms is the cost, and it is bounded by
 * the fact that a user can only ever hold ten codes.
 *
 * Single use is enforced by the `WHERE used_at IS NULL` on the update, not just by the
 * filter on the read: two simultaneous requests carrying the same code both find the row,
 * but only one `UPDATE` returns it, and the loser reports failure.
 */
export async function consumeBackupCode(
  db: Db,
  userId: string,
  input: string,
): Promise<ConsumeBackupCodeResult> {
  const code = canonicaliseBackupCode(input);
  if (!code) return { consumed: false, remaining: await countRemainingBackupCodes(db, userId) };

  const rows = await db
    .select({ id: mfaBackupCodes.id, codeHash: mfaBackupCodes.codeHash })
    .from(mfaBackupCodes)
    .where(and(eq(mfaBackupCodes.userId, userId), isNull(mfaBackupCodes.usedAt)));

  for (const row of rows) {
    let matches = false;
    try {
      matches = await argon2.verify(row.codeHash, code);
    } catch {
      // A corrupt hash is one dead code, not a 500 in the middle of someone's login.
      matches = false;
    }
    if (!matches) continue;

    const updated = await db
      .update(mfaBackupCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(mfaBackupCodes.id, row.id), isNull(mfaBackupCodes.usedAt)))
      .returning({ id: mfaBackupCodes.id });

    if (updated.length === 0) break; // Lost the race; treat as already spent.
    return { consumed: true, remaining: await countRemainingBackupCodes(db, userId) };
  }

  return { consumed: false, remaining: await countRemainingBackupCodes(db, userId) };
}
