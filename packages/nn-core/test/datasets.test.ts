import { describe, expect, it } from 'vitest';
import {
  DATASET_KINDS,
  type DatasetKind,
  blobs,
  circle,
  diagonal,
  makeDataset,
  moons,
  spiral,
  xor,
  xorNoisy,
} from '../src/datasets.js';
import { accuracy, createPerceptron, trainEpoch } from '../src/perceptron.js';
import { createRng } from '../src/random.js';

describe('every generator', () => {
  it.each(DATASET_KINDS)('%s produces well-formed, seeded points', (kind) => {
    const dataset = makeDataset(kind, { n: 40, seed: 3 });
    expect(dataset.length).toBeGreaterThan(0);

    for (const { x, y } of dataset) {
      expect(x).toHaveLength(2);
      expect(Number.isFinite(x[0])).toBe(true);
      expect(Number.isFinite(x[1])).toBe(true);
      expect([0, 1]).toContain(y);
      expect(Math.abs(x[0])).toBeLessThan(2);
      expect(Math.abs(x[1])).toBeLessThan(2);
    }

    // Both classes are present, or the exercise would be trivial.
    expect(new Set(dataset.map((point) => point.y)).size).toBe(2);
    // Same seed, same points.
    expect(makeDataset(kind, { n: 40, seed: 3 })).toEqual(dataset);
  });

  it.each(DATASET_KINDS.filter((kind) => kind !== 'xor'))('%s honours the n option', (kind) => {
    expect(makeDataset(kind, { n: 37, seed: 1 })).toHaveLength(37);
  });

  it.each(DATASET_KINDS.filter((kind) => kind !== 'xor'))('%s varies with the seed', (kind) => {
    expect(makeDataset(kind, { n: 20, seed: 1 })).not.toEqual(
      makeDataset(kind, { n: 20, seed: 2 }),
    );
  });

  it.each(DATASET_KINDS)('%s has a default size', (kind) => {
    expect(makeDataset(kind).length).toBeGreaterThanOrEqual(4);
  });

  it('rejects an unknown kind', () => {
    expect(() => makeDataset('helix' as DatasetKind)).toThrow(/unknown dataset/);
  });
});

describe('xor', () => {
  it('is exactly the four corners, with no randomness', () => {
    expect(xor()).toEqual([
      { x: [-1, -1], y: 0 },
      { x: [-1, 1], y: 1 },
      { x: [1, -1], y: 1 },
      { x: [1, 1], y: 0 },
    ]);
    expect(xor()).toEqual(xor());
  });

  it('labels a point by whether the coordinates disagree in sign', () => {
    for (const { x, y } of xor()) {
      expect(y).toBe(x[0] * x[1] < 0 ? 1 : 0);
    }
  });
});

describe('xorNoisy', () => {
  it('scatters around the four corners while keeping their labels', () => {
    const dataset = xorNoisy({ n: 40, seed: 5, noise: 0.1 });
    for (const { x, y } of dataset) {
      expect(y).toBe(Math.sign(x[0]) * Math.sign(x[1]) < 0 ? 1 : 0);
    }
  });
});

describe('linearly separable datasets', () => {
  it.each(['diagonal', 'blobs'] as const)('a perceptron reaches 100 %% on %s', (kind) => {
    const dataset = makeDataset(kind, { n: 60, seed: 6 });
    const p = createPerceptron(2, createRng(4));
    for (let epoch = 0; epoch < 300; epoch += 1) {
      trainEpoch(p, dataset, 0.05);
    }
    expect(accuracy(p, dataset)).toBe(1);
  });

  it('diagonal labels points by which side of x2 = x1 they fall on, with a margin', () => {
    for (const { x, y } of diagonal({ n: 50, seed: 2, noise: 0.2 })) {
      expect(y).toBe(x[1] > x[0] ? 1 : 0);
      expect(Math.abs(x[1] - x[0])).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('diagonal keeps a minimum margin even when asked for less noise', () => {
    for (const { x } of diagonal({ n: 30, seed: 2, noise: 0.01 })) {
      expect(Math.abs(x[1] - x[0])).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('blobs puts the two classes around opposite corners', () => {
    const dataset = blobs({ n: 60, seed: 1, noise: 0.05 });
    const centre = (label: 0 | 1): number => {
      const points = dataset.filter((point) => point.y === label);
      return points.reduce((total, point) => total + point.x[0] + point.x[1], 0) / points.length;
    };
    expect(centre(0)).toBeLessThan(0);
    expect(centre(1)).toBeGreaterThan(0);
  });
});

describe('non-linear datasets', () => {
  it('circle puts class 1 inside and class 0 in a ring outside', () => {
    const dataset = circle({ n: 80, seed: 4, noise: 0 });
    for (const { x, y } of dataset) {
      const radius = Math.hypot(x[0], x[1]);
      expect(y === 1 ? radius < 0.5 : radius > 0.7).toBe(true);
    }
  });

  it('moons produces two interleaved arcs that straddle the origin', () => {
    const dataset = moons({ n: 80, seed: 4, noise: 0 });
    const upper = dataset.filter((point) => point.y === 0);
    const lower = dataset.filter((point) => point.y === 1);
    const meanY = (points: typeof dataset): number =>
      points.reduce((total, point) => total + point.x[1], 0) / points.length;
    expect(meanY(upper)).toBeGreaterThan(meanY(lower));
  });

  it('spiral arms wind outwards and are 180 degrees apart', () => {
    const dataset = spiral({ n: 80, seed: 4, noise: 0 });
    const radii = dataset.filter((point) => point.y === 0).map((p) => Math.hypot(p.x[0], p.x[1]));
    expect(radii[radii.length - 1]).toBeGreaterThan(radii[0]!);
    // Mirror symmetry: the two arms are the same shape rotated by pi.
    const arm0 = dataset.filter((point) => point.y === 0);
    const arm1 = dataset.filter((point) => point.y === 1);
    expect(arm0[3]!.x[0]).toBeCloseTo(-arm1[3]!.x[0], 10);
    expect(arm0[3]!.x[1]).toBeCloseTo(-arm1[3]!.x[1], 10);
  });
});
