import { describe, expect, it } from 'vitest';
import { cosineSimilarity, pca, project } from '../src/pca.js';
import { normalize } from '../src/linalg.js';
import { createRng } from '../src/random.js';

describe('pca on a rank-1 matrix', () => {
  // Every row is the same direction scaled by a different amount, plus a common offset. The
  // data has exactly one direction of variation, and PCA must find it.
  const direction = normalize([3, 4, 0]);
  const offsets = [-2, -1, 0, 1, 2, 5];
  const data = offsets.map((t) => direction.map((d) => 10 + d * t));

  it('recovers the direction of variation', () => {
    const model = pca(data, 2);
    expect(model.components).toHaveLength(1);
    expect(Math.abs(cosineSimilarity(model.components[0]!, direction))).toBeCloseTo(1, 12);
    model.components[0]!.forEach((value, i) => {
      expect(value).toBeCloseTo(direction[i]!, 12);
    });
  });

  it('explains all of the variance with that one component', () => {
    const model = pca(data, 2);
    expect(model.explained[0]).toBeCloseTo(1, 12);
    expect(model.eigenvalues[0]).toBeGreaterThan(0);
  });

  it('recovers the column means', () => {
    const model = pca(data, 2);
    expect(model.mean[0]).toBeCloseTo(10 + 0.6 * (5 / 6), 12);
    expect(model.mean[2]).toBeCloseTo(10, 12);
  });

  it('projects each row back to its scalar offset, up to the centring', () => {
    const model = pca(data, 1);
    const projected = project(model, data);
    const meanOffset = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    projected.forEach((row, i) => {
      expect(row).toHaveLength(1);
      expect(row[0]).toBeCloseTo(offsets[i]! - meanOffset, 12);
    });
  });

  it('uses a stable sign convention, so the scatter plot does not flip between runs', () => {
    const flipped = offsets.map((t) => direction.map((d) => 10 - d * t));
    const forwards = pca(data, 1).components[0]!;
    const backwards = pca(flipped, 1).components[0]!;
    // The same data mirrored has the same principal axis, and the sign rule agrees on which
    // end of it to call positive.
    forwards.forEach((value, i) => {
      expect(value).toBeCloseTo(backwards[i]!, 12);
    });
    expect(forwards[0]).toBeGreaterThan(0);
  });
});

describe('pca on data with two directions', () => {
  it('orders components by variance and returns orthogonal unit vectors', () => {
    const rng = createRng(3);
    // Spread 5 along x, 1 along y, nothing along z.
    const data = Array.from({ length: 200 }, () => [rng.normal(0, 5), rng.normal(0, 1), 7]);

    const model = pca(data, 3);
    expect(model.components.length).toBeGreaterThanOrEqual(2);

    const [first, second] = model.components as [number[], number[]];
    expect(Math.abs(first[0]!)).toBeGreaterThan(0.99);
    expect(Math.abs(second[1]!)).toBeGreaterThan(0.99);
    expect(model.eigenvalues[0]!).toBeGreaterThan(model.eigenvalues[1]!);
    expect(cosineSimilarity(first, second)).toBeCloseTo(0, 6);

    for (const component of model.components) {
      expect(Math.hypot(...component)).toBeCloseTo(1, 12);
    }
    const totalExplained = model.explained.reduce((a, b) => a + b, 0);
    expect(totalExplained).toBeGreaterThan(0.99);
    expect(totalExplained).toBeLessThanOrEqual(1 + 1e-12);
  });

  it('accepts explicit iteration settings', () => {
    const rng = createRng(3);
    const data = Array.from({ length: 50 }, () => [rng.normal(0, 4), rng.normal(0, 1)]);
    const tight = pca(data, 2, { maxIterations: 2000, tolerance: 1e-15, seed: 99 });
    const loose = pca(data, 2, { maxIterations: 10, tolerance: 1e-3, seed: 99 });
    expect(Math.abs(cosineSimilarity(tight.components[0]!, loose.components[0]!))).toBeCloseTo(
      1,
      4,
    );
  });
});

describe('pca edge cases', () => {
  it('returns no components when there is no variance at all', () => {
    const model = pca(
      [
        [1, 1],
        [1, 1],
      ],
      2,
    );
    expect(model.components).toEqual([]);
    expect(model.explained).toEqual([]);
    expect(project(model, [[1, 1]])).toEqual([[]]);
  });

  it('handles a single row', () => {
    expect(pca([[1, 2, 3]], 2).components).toEqual([]);
  });

  it('never returns more components than the data has dimensions', () => {
    const rng = createRng(1);
    const data = Array.from({ length: 20 }, () => [rng.normal(), rng.normal()]);
    expect(pca(data, 10).components.length).toBeLessThanOrEqual(2);
  });

  it('rejects empty input', () => {
    expect(() => pca([], 2)).toThrow(/at least one row/);
    expect(() => pca([[]], 2)).toThrow(/at least one row/);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical directions and ignores magnitude', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 15);
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 15);
  });

  it('is -1 for opposite directions and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 15);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('rejects the zero vector, which has no direction', () => {
    expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow(/zero vector/);
  });
});
