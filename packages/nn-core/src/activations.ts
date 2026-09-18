/**
 * Activation functions and their derivatives.
 *
 * Convention: every `*Prime` function takes the *pre-activation* `z`, not the activation
 * `a`. So `sigmoidPrime(z) = sigma(z) * (1 - sigma(z))`. Backprop caches `z` per layer, so
 * taking `z` everywhere keeps `backward` free of special cases.
 */

export type ActivationKind = 'sigmoid' | 'tanh' | 'relu' | 'step';

/** Logistic sigmoid, squashing to (0, 1). */
export function sigmoid(z: number): number {
  // Two branches so neither `Math.exp` call can overflow: exp(-z) for z >= 0 and exp(z)
  // otherwise. The naive `1 / (1 + Math.exp(-z))` returns 0 for z around -746 but produces
  // Infinity/Infinity = NaN on some inputs in other formulations, and this form is exact at
  // the extremes.
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** d/dz sigmoid(z) = sigma(z)(1 - sigma(z)); peaks at 0.25 for z = 0. */
export function sigmoidPrime(z: number): number {
  const s = sigmoid(z);
  return s * (1 - s);
}

/** Hyperbolic tangent, squashing to (-1, 1): a rescaled sigmoid centred on zero. */
export function tanh(z: number): number {
  return Math.tanh(z);
}

/** d/dz tanh(z) = 1 - tanh(z)^2; peaks at 1 for z = 0, which is why tanh often trains faster. */
export function tanhPrime(z: number): number {
  const t = Math.tanh(z);
  return 1 - t * t;
}

/** Rectified linear unit: max(0, z). */
export function relu(z: number): number {
  return z > 0 ? z : 0;
}

/** d/dz relu(z); the kink at z = 0 has no derivative, so we use the usual convention of 0. */
export function reluPrime(z: number): number {
  return z > 0 ? 1 : 0;
}

/** Heaviside step with the `z >= 0 -> 1` convention that Module 1's quiz calls out. */
export function step(z: number): number {
  return z >= 0 ? 1 : 0;
}

/**
 * d/dz step(z) is 0 everywhere it exists. That is exactly why a perceptron cannot be trained
 * by gradient descent and gets its own update rule instead (see `perceptron.ts`).
 */
export function stepPrime(_z: number): number {
  return 0;
}

export interface Activation {
  readonly name: ActivationKind;
  readonly fn: (z: number) => number;
  readonly derivative: (z: number) => number;
}

/** Lookup table so a config string like `'tanh'` can pick a function pair. */
export const ACTIVATIONS: Readonly<Record<ActivationKind, Activation>> = {
  sigmoid: { name: 'sigmoid', fn: sigmoid, derivative: sigmoidPrime },
  tanh: { name: 'tanh', fn: tanh, derivative: tanhPrime },
  relu: { name: 'relu', fn: relu, derivative: reluPrime },
  step: { name: 'step', fn: step, derivative: stepPrime },
};

/** Resolve a kind to its function pair, failing loudly on a bad config value. */
export function getActivation(kind: ActivationKind): Activation {
  const activation = ACTIVATIONS[kind];
  if (activation === undefined) {
    throw new RangeError(`unknown activation: ${String(kind)}`);
  }
  return activation;
}

/** Apply an activation element-wise to a vector of pre-activations. */
export function applyActivation(kind: ActivationKind, zs: readonly number[]): number[] {
  const { fn } = getActivation(kind);
  return zs.map(fn);
}

/** Apply an activation's derivative element-wise to a vector of pre-activations. */
export function applyActivationDerivative(kind: ActivationKind, zs: readonly number[]): number[] {
  const { derivative } = getActivation(kind);
  return zs.map(derivative);
}

/**
 * Softmax: turn a vector of scores into a probability distribution.
 *
 * Subtracting the maximum before exponentiating changes nothing mathematically (the constant
 * cancels between numerator and denominator) but keeps `Math.exp` away from Infinity, so
 * `softmax([1000, 1001, 1002])` works instead of returning NaN.
 */
export function softmax(scores: readonly number[]): number[] {
  if (scores.length === 0) {
    return [];
  }
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i]! > max) {
      max = scores[i]!;
    }
  }
  const exps = scores.map((score) => Math.exp(score - max));
  let total = 0;
  for (let i = 0; i < exps.length; i += 1) {
    total += exps[i]!;
  }
  return exps.map((value) => value / total);
}
