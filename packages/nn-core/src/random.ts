/**
 * Seeded pseudo-random numbers.
 *
 * Every random thing in this package (weight initialisation, dataset generation, the
 * power-iteration start vector) goes through an `Rng` created here. That is what makes a
 * lesson reproducible: the same seed always produces the same network, the same points and
 * therefore the same picture on screen and the same numbers in the tests.
 *
 * The generator is mulberry32: a 32-bit state, three mixing steps, no dependencies. It is
 * not cryptographically secure and must never be used for tokens or passwords.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Normal (Gaussian) sample, default standard normal. */
  normal(mean?: number, stdDev?: number): number;
}

/**
 * Create a deterministic generator from a 32-bit seed.
 *
 * Two generators made with the same seed emit exactly the same sequence; a generator is
 * stateful, so drawing from it advances that sequence.
 */
export function createRng(seed: number): Rng {
  // `>>> 0` coerces to an unsigned 32-bit integer, so createRng(-1) and createRng(1.5) are
  // still well-defined rather than silently producing NaNs.
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Marsaglia's polar method produces two independent normals per pair of uniforms; the
  // second one is cached so no draw is wasted.
  let spare: number | null = null;

  const normal = (mean = 0, stdDev = 1): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return mean + stdDev * value;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = 2 * next() - 1;
      v = 2 * next() - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * factor;
    return mean + stdDev * (u * factor);
  };

  return {
    next,
    range: (min: number, max: number): number => min + (max - min) * next(),
    int: (maxExclusive: number): number => Math.floor(next() * maxExclusive),
    normal,
  };
}

/** The seed used wherever a caller does not supply one, so defaults stay reproducible. */
export const DEFAULT_SEED = 42;
