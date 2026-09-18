import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED, createRng } from '../src/random.js';

describe('createRng', () => {
  it('is deterministic: the same seed replays the same sequence', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const first = Array.from({ length: 20 }, () => a.next());
    const second = Array.from({ length: 20 }, () => b.next());
    expect(first).toEqual(second);
  });

  it('is stateful: consecutive draws differ', () => {
    const rng = createRng(1);
    const draws = new Set(Array.from({ length: 50 }, () => rng.next()));
    expect(draws.size).toBe(50);
  });

  it('gives different sequences for different seeds', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('pins the mulberry32 sequence for seed 42 so fixtures cannot drift silently', () => {
    const rng = createRng(42);
    const draws = [rng.next(), rng.next(), rng.next()];
    expect(draws[0]).toBeCloseTo(0.6011037519201636, 15);
    expect(draws[1]).toBeCloseTo(0.44829055899754167, 15);
    expect(draws[2]).toBeCloseTo(0.8524657934904099, 15);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('coerces odd seeds to a valid 32-bit state', () => {
    expect(Number.isFinite(createRng(-1).next())).toBe(true);
    expect(Number.isFinite(createRng(1.5).next())).toBe(true);
  });

  it('range() stays within the requested interval', () => {
    const rng = createRng(DEFAULT_SEED);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.range(-3, 5);
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThan(5);
    }
  });

  it('int() returns integers in [0, maxExclusive)', () => {
    const rng = createRng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const value = rng.int(4);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(4);
      seen.add(value);
    }
    expect(seen.size).toBe(4);
  });

  it('normal() has roughly the requested mean and standard deviation', () => {
    const rng = createRng(2024);
    const n = 20000;
    const samples = Array.from({ length: n }, () => rng.normal(2, 3));
    const mean = samples.reduce((a, b) => a + b, 0) / n;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    expect(mean).toBeCloseTo(2, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(3, 1);
  });

  it('normal() defaults to the standard normal and is reproducible', () => {
    const a = createRng(5);
    const b = createRng(5);
    // Two draws, so the second one comes from the cached "spare" of the polar method.
    expect([a.normal(), a.normal()]).toEqual([b.normal(), b.normal()]);
  });
});
