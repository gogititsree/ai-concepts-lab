import { describe, expect, it } from 'vitest';
import { scaledDotProductAttention, softmaxRows } from '../src/attention.js';

const Q = [
  [1, 0, 0],
  [0, 1, 0],
];
const K = [
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
];
const V = [
  [1, 0],
  [0, 1],
  [0.5, 0.5],
];

const rowSum = (row: readonly number[]): number => row.reduce((a, b) => a + b, 0);

describe('scaledDotProductAttention', () => {
  it('produces weight rows that sum to 1 within 1e-12', () => {
    const { weights } = scaledDotProductAttention(Q, K, V);
    expect(weights).toHaveLength(Q.length);
    for (const row of weights) {
      expect(row).toHaveLength(K.length);
      expect(rowSum(row)).toBeCloseTo(1, 12);
      expect(row.every((w) => w >= 0)).toBe(true);
    }
  });

  it('gives uniform weights when every key is identical', () => {
    // With nothing to distinguish the keys, every score is equal and softmax is uniform --
    // attention has no opinion, so the output is just the average of the values.
    const identical = [
      [1, 1],
      [1, 1],
      [1, 1],
    ];
    const values = [
      [1, 0],
      [0, 1],
      [2, 2],
    ];
    const { weights, output } = scaledDotProductAttention([[0.3, 0.7]], identical, values);
    for (const w of weights[0]!) {
      expect(w).toBeCloseTo(1 / 3, 15);
    }
    expect(output[0]![0]).toBeCloseTo(1, 12);
    expect(output[0]![1]).toBeCloseTo(1, 12);
  });

  it('attends most to the key a query matches', () => {
    const { weights } = scaledDotProductAttention([[1, 0, 0]], K, V);
    const row = weights[0]!;
    expect(row[0]).toBeGreaterThan(row[1]!);
    expect(row[2]).toBeGreaterThan(row[1]!);
    expect(row[0]).toBeCloseTo(row[2]!, 12); // both keys score 1 against this query
  });

  it('the output is the weighted average of the value rows', () => {
    const { weights, output } = scaledDotProductAttention(Q, K, V);
    for (let q = 0; q < Q.length; q += 1) {
      for (let d = 0; d < 2; d += 1) {
        const expected = V.reduce((total, value, k) => total + weights[q]![k]! * value[d]!, 0);
        expect(output[q]![d]).toBeCloseTo(expected, 15);
      }
    }
  });

  it('divides the scores by sqrt(d_k) unless scaling is turned off', () => {
    const scaled = scaledDotProductAttention(Q, K, V);
    const unscaled = scaledDotProductAttention(Q, K, V, { scale: false });
    expect(unscaled.scores[0]).toEqual([1, 0, 1]);
    expect(scaled.scores[0]![0]).toBeCloseTo(1 / Math.sqrt(3), 15);
    // Bigger scores mean a peakier softmax, which is exactly the saturation problem the
    // scaling exists to avoid.
    expect(Math.max(...unscaled.weights[0]!)).toBeGreaterThan(Math.max(...scaled.weights[0]!));
  });

  it('temperature sharpens below 1 and flattens above it', () => {
    const base = scaledDotProductAttention(Q, K, V);
    const sharp = scaledDotProductAttention(Q, K, V, { temperature: 0.1 });
    const flat = scaledDotProductAttention(Q, K, V, { temperature: 10 });

    expect(Math.max(...sharp.weights[0]!)).toBeGreaterThan(Math.max(...base.weights[0]!));
    expect(Math.max(...flat.weights[0]!)).toBeLessThan(Math.max(...base.weights[0]!));
    // A very high temperature tends to the uniform distribution.
    for (const w of flat.weights[0]!) {
      expect(w).toBeCloseTo(1 / 3, 1);
    }
    // Temperature changes the weights but not the reported scores.
    expect(sharp.scores).toEqual(base.scores);
    for (const row of [...sharp.weights, ...flat.weights]) {
      expect(rowSum(row)).toBeCloseTo(1, 12);
    }
  });

  it('rejects mismatched shapes', () => {
    expect(() => scaledDotProductAttention([[1, 2]], [[1, 2, 3]], V)).toThrow(/queries are 2-d/);
    expect(() => scaledDotProductAttention(Q, K, [[1, 2]])).toThrow(/3 keys but 1 values/);
  });
});

describe('softmaxRows', () => {
  it('normalises each row independently', () => {
    const rows = softmaxRows([
      [1, 1],
      [0, 10],
    ]);
    expect(rows[0]).toEqual([0.5, 0.5]);
    expect(rowSum(rows[1]!)).toBeCloseTo(1, 15);
    expect(rows[1]![1]).toBeGreaterThan(0.99);
  });

  it('rejects a non-positive temperature', () => {
    expect(() => softmaxRows([[1, 2]], 0)).toThrow(/temperature/);
    expect(() => softmaxRows([[1, 2]], -1)).toThrow(/temperature/);
    expect(() => softmaxRows([[1, 2]], Number.NaN)).toThrow(/temperature/);
  });
});
