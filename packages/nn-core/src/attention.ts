/**
 * Scaled dot-product attention -- the one equation behind every transformer:
 *
 *   Attention(Q, K, V) = softmax(Q K^T / sqrt(d_k)) V
 *
 * Read it right to left: each query row scores every key by dot product (how relevant is this
 * token to me?), softmax turns that row of scores into weights that sum to 1, and the output
 * is the weighted average of the value vectors.
 */

import { softmax } from './activations.js';
import { matMul, shape, transpose } from './linalg.js';

export interface AttentionOptions {
  /**
   * Divide the scores by sqrt(d_k) before the softmax. On by default.
   *
   * Dot products grow with the dimension of the vectors, so without the scaling a wide model
   * produces huge scores, the softmax saturates into a one-hot row, and the gradient through
   * it vanishes. The exercise exposes this as a toggle so the effect is visible.
   */
  scale?: boolean;
  /**
   * Softmax temperature. 1 is the default; higher flattens the weights towards uniform, lower
   * sharpens them towards picking a single key. Must be > 0.
   */
  temperature?: number;
}

export interface AttentionResult {
  /** `scores[q][k]`: the raw dot products, after the sqrt(d_k) scaling, before the softmax. */
  scores: number[][];
  /** `weights[q][k]`; every row sums to 1. */
  weights: number[][];
  /** `output[q]` is the weighted average of the value rows. */
  output: number[][];
}

/** Apply a softmax to each row independently, optionally dividing by a temperature first. */
export function softmaxRows(matrix: readonly number[][], temperature = 1): number[][] {
  if (!(temperature > 0)) {
    throw new RangeError(`softmaxRows: temperature must be > 0, got ${temperature}`);
  }
  return matrix.map((row) => softmax(temperature === 1 ? row : row.map((v) => v / temperature)));
}

/**
 * Compute attention for a batch of queries.
 *
 * `Q` is `nQueries x d_k`, `K` is `nKeys x d_k`, `V` is `nKeys x d_v`.
 */
export function scaledDotProductAttention(
  Q: readonly number[][],
  K: readonly number[][],
  V: readonly number[][],
  options: AttentionOptions = {},
): AttentionResult {
  const { scale = true, temperature = 1 } = options;
  const [, queryDim] = shape(Q);
  const [keyCount, keyDim] = shape(K);
  const [valueCount] = shape(V);

  if (queryDim !== keyDim) {
    throw new RangeError(`attention: queries are ${queryDim}-d but keys are ${keyDim}-d`);
  }
  if (keyCount !== valueCount) {
    throw new RangeError(`attention: ${keyCount} keys but ${valueCount} values`);
  }

  const raw = matMul(Q, transpose(K));
  const factor = scale && keyDim > 0 ? 1 / Math.sqrt(keyDim) : 1;
  const scores = factor === 1 ? raw : raw.map((row) => row.map((value) => value * factor));
  const weights = softmaxRows(scores, temperature);
  const output = matMul(weights, V);

  return { scores, weights, output };
}
