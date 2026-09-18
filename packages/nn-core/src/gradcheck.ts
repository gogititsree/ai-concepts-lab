/**
 * Numerical gradient checking: the unit test for backpropagation.
 *
 * Analytic gradients come from the chain rule, which is easy to get subtly wrong (a
 * transpose, an off-by-one in the cache, a derivative evaluated at `a` instead of `z`).
 * Finite differences come from the definition of a derivative and are almost impossible to
 * get wrong. If the two agree to ten digits, `backward` is right.
 *
 * Central differences `(L(w + eps) - L(w - eps)) / (2 eps)` are used rather than the forward
 * difference `(L(w + eps) - L(w)) / eps` because the error term is O(eps^2) instead of
 * O(eps) -- two extra digits for one extra forward pass.
 */

import { type LossKind, type Mlp, backward, clone, forward, loss } from './mlp.js';

export interface GradCheckEntry {
  /** Human-readable location, e.g. `layer0.W[1][0]` or `layer1.b[0]`. */
  parameter: string;
  layer: number;
  kind: 'weight' | 'bias';
  /** Index of the unit inside the layer. */
  unit: number;
  /** Index of the incoming connection, or null for a bias. */
  input: number | null;
  analytic: number;
  numeric: number;
  relativeError: number;
}

export interface GradCheckResult {
  maxRelativeError: number;
  /** The entry that produced `maxRelativeError`, or null for a model with no parameters. */
  worst: GradCheckEntry | null;
  entries: GradCheckEntry[];
  parameterCount: number;
  eps: number;
}

/**
 * Scale-free disagreement between two numbers.
 *
 * The floor in the denominator keeps the ratio meaningful when both gradients are
 * legitimately near zero -- otherwise floating-point dust divided by floating-point dust
 * looks like a catastrophic error.
 */
export function relativeError(a: number, b: number): number {
  const denominator = Math.max(Math.abs(a), Math.abs(b), 1e-8);
  return Math.abs(a - b) / denominator;
}

/**
 * Compare `backward`'s gradients against central finite differences for every parameter.
 *
 * Neither `mlp` nor its weights are modified: the probing happens on a deep copy.
 *
 * `eps` of 1e-5 is the sweet spot for float64. Much larger and the O(eps^2) truncation error
 * dominates; much smaller and `L(w + eps) - L(w - eps)` loses its significant digits to
 * cancellation.
 */
export function gradientCheck(
  mlp: Mlp,
  x: readonly number[],
  y: readonly number[],
  lossKind: LossKind = 'mse',
  eps = 1e-5,
): GradCheckResult {
  const analytic = backward(mlp, forward(mlp, x), y, lossKind);
  const probe = clone(mlp);
  const entries: GradCheckEntry[] = [];

  const measure = (
    read: () => number,
    write: (value: number) => void,
    analyticValue: number,
    describe: Omit<GradCheckEntry, 'analytic' | 'numeric' | 'relativeError'>,
  ): void => {
    const original = read();
    write(original + eps);
    const lossPlus = loss(lossKind, forward(probe, x).output, y);
    write(original - eps);
    const lossMinus = loss(lossKind, forward(probe, x).output, y);
    write(original);
    const numeric = (lossPlus - lossMinus) / (2 * eps);
    entries.push({
      ...describe,
      analytic: analyticValue,
      numeric,
      relativeError: relativeError(analyticValue, numeric),
    });
  };

  for (let l = 0; l < probe.layers.length; l += 1) {
    const layer = probe.layers[l]!;
    for (let j = 0; j < layer.weights.length; j += 1) {
      const row = layer.weights[j]!;
      for (let i = 0; i < row.length; i += 1) {
        measure(
          () => row[i]!,
          (value) => {
            row[i] = value;
          },
          analytic.dWeights[l]![j]![i]!,
          { parameter: `layer${l}.W[${j}][${i}]`, layer: l, kind: 'weight', unit: j, input: i },
        );
      }
      measure(
        () => layer.biases[j]!,
        (value) => {
          layer.biases[j] = value;
        },
        analytic.dBiases[l]![j]!,
        { parameter: `layer${l}.b[${j}]`, layer: l, kind: 'bias', unit: j, input: null },
      );
    }
  }

  let maxRelativeError = 0;
  let worst: GradCheckEntry | null = null;
  // `>=` rather than `>` so the first entry always becomes the incumbent.
  for (const entry of entries) {
    if (entry.relativeError >= maxRelativeError) {
      maxRelativeError = entry.relativeError;
      worst = entry;
    }
  }

  return {
    maxRelativeError,
    worst,
    entries,
    parameterCount: entries.length,
    eps,
  };
}
