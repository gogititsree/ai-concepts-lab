/**
 * A single neuron with a step activation, plus the perceptron learning rule.
 *
 * This is Module 1 in about forty lines: `z = w . x + b`, output 1 when `z >= 0`, and the
 * update `w <- w + lr (y - yhat) x`. It converges in finite time on linearly separable data
 * and provably cannot separate XOR, which is the whole setup for Module 2.
 */

import { type Rng, createRng, DEFAULT_SEED } from './random.js';
import { dot } from './linalg.js';
import { step } from './activations.js';

/** A labelled example. `x` is the feature vector; `y` is the target class. */
export interface LabeledSample {
  x: readonly number[];
  y: 0 | 1;
}

/** Plain data so it can live in a Zustand store and be JSON round-tripped. */
export interface Perceptron {
  weights: number[];
  bias: number;
}

/**
 * A new perceptron with small random weights.
 *
 * The starting point barely matters for convergence, but it must be reproducible so a
 * learner who hits "reset" gets the same picture twice.
 */
export function createPerceptron(
  inputSize: number,
  rng: Rng = createRng(DEFAULT_SEED),
): Perceptron {
  if (inputSize < 1) {
    throw new RangeError(`createPerceptron: inputSize must be >= 1, got ${inputSize}`);
  }
  return {
    weights: Array.from({ length: inputSize }, () => rng.range(-0.5, 0.5)),
    bias: rng.range(-0.5, 0.5),
  };
}

/** Deep copy, for storing a "before" snapshot without aliasing the live weights. */
export function clone(p: Perceptron): Perceptron {
  return { weights: [...p.weights], bias: p.bias };
}

/** The pre-activation `z = w . x + b`. Its sign is the side of the line `x` falls on. */
export function netInput(p: Perceptron, x: readonly number[]): number {
  return dot(p.weights, x) + p.bias;
}

/** Predicted class, using the `z >= 0 -> 1` convention. */
export function predict(p: Perceptron, x: readonly number[]): 0 | 1 {
  return step(netInput(p, x)) === 1 ? 1 : 0;
}

/**
 * One example, one update. Returns whether the weights actually moved.
 *
 * The rule only fires on a mistake: when `y === yhat` the error is 0 and the update is a
 * no-op, which is why a run over separable data eventually goes quiet.
 */
export function trainStep(p: Perceptron, x: readonly number[], y: 0 | 1, lr: number): boolean {
  const error = y - predict(p, x);
  if (error === 0) {
    return false;
  }
  for (let i = 0; i < p.weights.length; i += 1) {
    p.weights[i]! += lr * error * x[i]!;
  }
  p.bias += lr * error;
  return true;
}

/**
 * One pass over the dataset in order, updating as it goes. Returns the number of examples
 * that were misclassified *when they were seen*, so 0 means the epoch ended with a
 * separating line and nothing left to fix.
 */
export function trainEpoch(p: Perceptron, dataset: readonly LabeledSample[], lr: number): number {
  let misclassified = 0;
  for (const sample of dataset) {
    if (trainStep(p, sample.x, sample.y, lr)) {
      misclassified += 1;
    }
  }
  return misclassified;
}

/** Fraction of the dataset classified correctly, in [0, 1]. An empty dataset scores 1. */
export function accuracy(p: Perceptron, dataset: readonly LabeledSample[]): number {
  if (dataset.length === 0) {
    return 1;
  }
  let correct = 0;
  for (const sample of dataset) {
    if (predict(p, sample.x) === sample.y) {
      correct += 1;
    }
  }
  return correct / dataset.length;
}

export type Point = readonly [number, number];

/**
 * The decision boundary of a 2-D perceptron, ready to draw.
 *
 * `w1 x1 + w2 x2 + b = 0` is a line. Solving for `x2` gives slope `-w1/w2` and intercept
 * `-b/w2` -- unless `w2` is 0, in which case the line is vertical at `x1 = -b/w1`, and if
 * both weights are 0 there is no line at all (the neuron answers the same thing everywhere).
 */
export type DecisionLine =
  | { kind: 'sloped'; slope: number; intercept: number; points: [Point, Point] }
  | { kind: 'vertical'; x: number; points: [Point, Point] }
  | { kind: 'none' };

export function decisionLine(p: Perceptron, xMin = -1.5, xMax = 1.5): DecisionLine {
  if (p.weights.length !== 2) {
    throw new RangeError(`decisionLine: expects a 2-D perceptron, got ${p.weights.length} inputs`);
  }
  const [w1, w2] = [p.weights[0]!, p.weights[1]!];
  if (w2 === 0) {
    if (w1 === 0) {
      return { kind: 'none' };
    }
    const x = -p.bias / w1;
    return {
      kind: 'vertical',
      x,
      points: [
        [x, xMin],
        [x, xMax],
      ],
    };
  }
  const slope = -w1 / w2;
  const intercept = -p.bias / w2;
  return {
    kind: 'sloped',
    slope,
    intercept,
    points: [
      [xMin, slope * xMin + intercept],
      [xMax, slope * xMax + intercept],
    ],
  };
}
