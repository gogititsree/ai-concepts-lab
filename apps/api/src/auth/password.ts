import argon2 from 'argon2';

/**
 * Password hashing. One module, four functions, no policy decisions: the *policy*
 * (length, common-password list) lives in `@lab/shared` because the browser wants it too;
 * this file only turns a password into a hash and back into a yes/no.
 */

/**
 * OWASP's current argon2id recommendation and the numbers written down in
 * `docs/03-auth-mfa.md`: 64 MiB of memory, three passes, one lane.
 *
 * Memory cost is the parameter that matters against GPU cracking — time cost alone is
 * cheap to parallelise, memory is not. Parallelism 1 keeps a login from eating several
 * cores on a free-tier instance; the encoded hash records all three, so raising them
 * later is a config change plus `needsRehash` on the next successful login, not a
 * migration.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536, // KiB → 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

/**
 * A real argon2id hash of a throwaway string, generated once with the parameters above
 * and pasted in as a constant.
 *
 * Its job is timing: `POST /auth/login` for an unknown email must cost the same as one
 * for a known email with the wrong password. Without this, "no user → return 401
 * immediately" is a ~100 ms side channel that enumerates registered addresses. It is
 * hard-coded rather than computed at boot so the cost is identical on every process and
 * there is no startup hiccup.
 *
 * It must be regenerated if `ARGON2_OPTIONS` changes, otherwise the dummy verify does a
 * different amount of work than a real one; `password.test.ts` asserts the parameters
 * embedded in this string still match.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=1,t=3$cktQnwyfSRd+26FJuw30WA$mc0LpYfmHv0arHcG6Mzj0kU3la/DnQ1Lrpe0ODIZXWo';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verifies a password against an encoded hash.
 *
 * Returns `false` instead of throwing when the stored string is not a valid argon2 hash:
 * a corrupt row is a failed login, not a 500 that tells the caller something interesting
 * about the account.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Burns the same CPU a real verification would, then reports failure.
 *
 * Called on the "unknown email" branch of login so the response time carries no
 * information. (It is approximate — argon2 timing varies — but it removes the order-of-
 * magnitude difference, which is the part an attacker can measure over the network.)
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  await verifyPassword(DUMMY_PASSWORD_HASH, password);
  return false;
}

/**
 * True when the stored hash was produced with weaker parameters than the current ones.
 *
 * Called after a *successful* login — the only moment the plaintext is available — so the
 * fleet upgrades itself as people log in, with no password reset email.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    // Unparseable hash: treat it as stale so the next successful login replaces it.
    return true;
  }
}
