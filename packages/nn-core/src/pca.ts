/**
 * Principal component analysis by power iteration with deflation.
 *
 * Module 3 uses it for one job: squash 768-dimensional embedding vectors down to two numbers
 * so they can be points on a scatter plot. PCA picks the two directions along which the data
 * varies most, which is the least-lossy pair of axes a linear projection can choose.
 *
 * Power iteration is used instead of a full eigendecomposition because it is ten lines, needs
 * only matrix-vector products (already in `linalg.ts`), and converges quickly when you only
 * want the top few components. Deflation -- subtracting `lambda v v^T` from the covariance
 * after each component -- is what makes the next iteration find the *next* direction.
 */

import {
  columnMeans,
  dot,
  matVec,
  norm,
  normalize,
  scale,
  shape,
  subtract,
  zerosMatrix,
} from './linalg.js';
import { createRng } from './random.js';

export interface PcaModel {
  /** `components[i]` is the i-th principal direction, a unit vector. */
  components: number[][];
  /** Column means subtracted before projecting. */
  mean: number[];
  /** Fraction of total variance captured by each component, in the same order. */
  explained: number[];
  /** Eigenvalues of the covariance matrix (the variance along each component). */
  eigenvalues: number[];
}

export interface PcaOptions {
  /** Maximum power-iteration steps per component. */
  maxIterations?: number;
  /** Stop when the direction moves less than this between iterations. */
  tolerance?: number;
  /** Seed for the (deterministic) random start vector. */
  seed?: number;
}

/** Covariance matrix of already-centred data, using the unbiased 1/(n-1) normalisation. */
function covariance(centred: readonly number[][]): number[][] {
  const [rows, cols] = shape(centred);
  const out = zerosMatrix(cols, cols);
  const denominator = rows > 1 ? rows - 1 : 1;
  for (let r = 0; r < rows; r += 1) {
    const row = centred[r]!;
    for (let i = 0; i < cols; i += 1) {
      const vi = row[i]!;
      if (vi === 0) continue;
      const outRow = out[i]!;
      for (let j = 0; j < cols; j += 1) {
        outRow[j]! += (vi * row[j]!) / denominator;
      }
    }
  }
  return out;
}

/**
 * Fix the sign of an eigenvector.
 *
 * `v` and `-v` are equally valid principal directions, and which one power iteration lands on
 * depends on the start vector. Forcing the largest-magnitude entry positive makes the result
 * stable across runs, which matters both for tests and for a scatter plot that should not flip
 * when the user changes an unrelated setting.
 */
function canonicalSign(v: readonly number[]): number[] {
  let pivot = 0;
  for (let i = 1; i < v.length; i += 1) {
    if (Math.abs(v[i]!) > Math.abs(v[pivot]!)) {
      pivot = i;
    }
  }
  return v[pivot]! < 0 ? scale(v, -1) : [...v];
}

/**
 * Fit `k` principal components.
 *
 * Returns fewer than `k` components if the data has fewer dimensions, or if the remaining
 * variance is numerically zero (a rank-1 matrix genuinely has only one direction).
 */
export function pca(data: readonly number[][], k = 2, options: PcaOptions = {}): PcaModel {
  const { maxIterations = 500, tolerance = 1e-12, seed = 7 } = options;
  const [rows, cols] = shape(data);
  if (rows === 0 || cols === 0) {
    throw new RangeError('pca: needs at least one row and one column');
  }

  const mean = columnMeans(data);
  const centred = data.map((row) => subtract(row, mean));
  const matrix = covariance(centred);

  // The trace of a covariance matrix is the total variance, so it is the denominator for
  // "explained variance ratio".
  let totalVariance = 0;
  for (let i = 0; i < cols; i += 1) {
    totalVariance += matrix[i]![i]!;
  }

  const rng = createRng(seed);
  const components: number[][] = [];
  const eigenvalues: number[] = [];
  const wanted = Math.min(k, cols);

  for (let c = 0; c < wanted; c += 1) {
    // A random start is almost surely not orthogonal to the dominant eigenvector, which is the
    // one condition power iteration needs.
    let v = normalize(Array.from({ length: cols }, () => rng.normal()));

    let eigenvalue = 0;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const next = matVec(matrix, v);
      const length = norm(next);
      if (length < 1e-300) {
        // The deflated matrix is effectively zero: no variance left to explain.
        eigenvalue = 0;
        break;
      }
      const normalized = scale(next, 1 / length);
      // Rayleigh quotient; for a unit vector this is just v^T A v.
      eigenvalue = dot(normalized, matVec(matrix, normalized));
      const movement = norm(subtract(normalized, v));
      v = normalized;
      if (movement < tolerance) {
        break;
      }
    }

    if (eigenvalue <= 1e-12 * Math.max(1, totalVariance)) {
      break;
    }

    components.push(canonicalSign(v));
    eigenvalues.push(eigenvalue);

    // Deflate: remove this direction's contribution so the next pass finds the next one.
    for (let i = 0; i < cols; i += 1) {
      const row = matrix[i]!;
      for (let j = 0; j < cols; j += 1) {
        row[j]! -= eigenvalue * v[i]! * v[j]!;
      }
    }
  }

  // `totalVariance` cannot be 0 here: a component only makes it into the list if its
  // eigenvalue cleared a threshold that is itself proportional to the total variance.
  const explained = eigenvalues.map((value) => value / totalVariance);
  return { components, mean, explained, eigenvalues };
}

/** Project rows into the component space: centre, then dot with each component. */
export function project(model: PcaModel, data: readonly number[][]): number[][] {
  return data.map((row) => {
    const centred = subtract(row, model.mean);
    return model.components.map((component) => dot(centred, component));
  });
}

/**
 * Cosine of the angle between two vectors, in [-1, 1].
 *
 * Unlike a raw dot product it ignores magnitude, which is what you want for embeddings: two
 * words point the same way whether or not one has a longer vector.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const denominator = norm(a) * norm(b);
  if (denominator === 0) {
    throw new RangeError('cosineSimilarity: the zero vector has no direction');
  }
  return dot(a, b) / denominator;
}
