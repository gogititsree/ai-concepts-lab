/**
 * The flagship test of this package, and the one Lesson 2.4 points at.
 *
 * Backprop is derived by hand and implemented by hand, so it needs an independent oracle.
 * Central finite differences are that oracle: they only use `forward` and the definition of a
 * derivative, so they cannot share a bug with `backward`. Agreement to better than 1e-6
 * relative error means the chain rule was applied correctly for every parameter.
 */

import { describe, expect, it } from 'vitest';
import { gradientCheck, relativeError } from '../src/gradcheck.js';
import {
  type HiddenActivationKind,
  type LossKind,
  applyGradients,
  backward,
  createMlp,
  forward,
  lossGradient,
} from '../src/mlp.js';

const TOLERANCE = 1e-6;
const X = [0.35, -0.72];
const Y = [1];

const cases: { hidden: HiddenActivationKind; lossKind: LossKind }[] = [
  { hidden: 'sigmoid', lossKind: 'mse' },
  { hidden: 'sigmoid', lossKind: 'bce' },
  { hidden: 'tanh', lossKind: 'mse' },
  { hidden: 'tanh', lossKind: 'bce' },
  { hidden: 'relu', lossKind: 'mse' },
  { hidden: 'relu', lossKind: 'bce' },
];

describe('gradientCheck on a fixed seed', () => {
  it.each(cases)(
    'max relative error < 1e-6 for $hidden hidden layers and $lossKind loss',
    ({ hidden, lossKind }) => {
      const mlp = createMlp({
        layerSizes: [2, 4, 3, 1],
        hiddenActivation: hidden,
        outputActivation: 'sigmoid',
        seed: 42,
      });

      const result = gradientCheck(mlp, X, Y, lossKind);

      expect(result.parameterCount).toBe(4 * 2 + 4 + (3 * 4 + 3) + (1 * 3 + 1));
      expect(result.entries).toHaveLength(result.parameterCount);
      expect(result.maxRelativeError).toBeLessThan(TOLERANCE);
      expect(result.worst?.relativeError).toBe(result.maxRelativeError);
    },
  );

  it('holds across several seeds, not just a lucky one', () => {
    for (const seed of [1, 7, 42, 2024]) {
      for (const lossKind of ['mse', 'bce'] as const) {
        const mlp = createMlp({
          layerSizes: [2, 5, 1],
          hiddenActivation: 'tanh',
          outputActivation: 'sigmoid',
          seed,
        });
        expect(gradientCheck(mlp, X, Y, lossKind).maxRelativeError).toBeLessThan(TOLERANCE);
      }
    }
  });

  it('holds for a multi-output network', () => {
    const mlp = createMlp({
      layerSizes: [3, 5, 2],
      hiddenActivation: 'tanh',
      outputActivation: 'sigmoid',
      seed: 11,
    });
    for (const lossKind of ['mse', 'bce'] as const) {
      expect(gradientCheck(mlp, [0.1, -0.4, 0.9], [1, 0], lossKind).maxRelativeError).toBeLessThan(
        TOLERANCE,
      );
    }
  });

  it('still holds part-way through training, not just at initialisation', () => {
    const mlp = createMlp({
      layerSizes: [2, 4, 1],
      hiddenActivation: 'tanh',
      outputActivation: 'sigmoid',
      seed: 3,
    });
    for (let i = 0; i < 200; i += 1) {
      applyGradients(mlp, backward(mlp, forward(mlp, X), Y, 'bce'), 0.5);
    }
    expect(gradientCheck(mlp, X, Y, 'bce').maxRelativeError).toBeLessThan(TOLERANCE);
  });

  it('reports every parameter with a readable name', () => {
    const mlp = createMlp({ layerSizes: [2, 2, 1], seed: 5 });
    const names = gradientCheck(mlp, X, Y).entries.map((entry) => entry.parameter);
    expect(names).toEqual([
      'layer0.W[0][0]',
      'layer0.W[0][1]',
      'layer0.b[0]',
      'layer0.W[1][0]',
      'layer0.W[1][1]',
      'layer0.b[1]',
      'layer1.W[0][0]',
      'layer1.W[0][1]',
      'layer1.b[0]',
    ]);
  });

  it('does not disturb the model it is checking', () => {
    const mlp = createMlp({ layerSizes: [2, 3, 1], seed: 17 });
    const before = JSON.stringify(mlp);
    gradientCheck(mlp, X, Y, 'mse');
    expect(JSON.stringify(mlp)).toBe(before);
  });

  it('echoes back the epsilon it used', () => {
    expect(gradientCheck(createMlp({ layerSizes: [2, 2, 1] }), X, Y, 'mse', 1e-4).eps).toBe(1e-4);
  });

  it('is not vacuous: the classic backprop bug fails it by a wide margin', () => {
    // The bug: using dL/dyhat straight as the output delta and forgetting to multiply by the
    // output activation's derivative. The check must reject that, or it proves nothing.
    const mlp = createMlp({ layerSizes: [2, 3, 1], seed: 4 });
    const cache = forward(mlp, X);
    const correct = backward(mlp, cache, Y, 'mse').dWeights[1]![0]![0]!;
    const buggy = lossGradient('mse', cache.output, Y)[0]! * cache.activations[1]![0]!;
    expect(relativeError(buggy, correct)).toBeGreaterThan(0.5);
  });
});

describe('relativeError', () => {
  it('is 0 for identical values and 1 for opposite signs', () => {
    expect(relativeError(0.5, 0.5)).toBe(0);
    expect(relativeError(0.5, -0.5)).toBe(2);
  });

  it('is scale free', () => {
    expect(relativeError(1000, 1001)).toBeCloseTo(relativeError(1, 1.001), 6);
  });

  it('does not blow up when both values are numerically zero', () => {
    expect(relativeError(1e-18, -1e-18)).toBeLessThan(1e-9);
    expect(relativeError(0, 0)).toBe(0);
  });
});
