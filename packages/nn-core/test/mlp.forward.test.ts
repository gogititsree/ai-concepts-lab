import { describe, expect, it } from 'vitest';
import {
  type Mlp,
  backward,
  clone,
  countParameters,
  createMlp,
  forward,
  loss,
  lossGradient,
  predict,
  xavierLimit,
} from '../src/mlp.js';
import { sigmoid } from '../src/activations.js';

/**
 * The worked example for Lesson 2.2, reproduced verbatim in `README.md`.
 *
 * A 2-2-1 network, sigmoid everywhere, with weights chosen so every number can be checked on
 * paper. If any of these assertions move, the lesson is wrong -- which is exactly the coupling
 * we want between the curriculum and the code.
 *
 *   W1 = [[0.15, 0.20],      b1 = [0.35, 0.35]
 *         [0.25, 0.30]]
 *   W2 = [[0.40, 0.45]]      b2 = [0.60]
 *   x  = [0.05, 0.10]        y  = [0.01]
 */
const WORKED_EXAMPLE: Mlp = {
  layerSizes: [2, 2, 1],
  hiddenActivation: 'sigmoid',
  outputActivation: 'sigmoid',
  seed: 0,
  layers: [
    {
      weights: [
        [0.15, 0.2],
        [0.25, 0.3],
      ],
      biases: [0.35, 0.35],
      activation: 'sigmoid',
    },
    { weights: [[0.4, 0.45]], biases: [0.6], activation: 'sigmoid' },
  ],
};

const X = [0.05, 0.1];
const Y = [0.01];

// Hand-computed, to twelve decimal places.
const Z1 = [0.3775, 0.3925];
const A1 = [0.593269992107, 0.596884378259];
const Z2 = [1.10590596706];
const A2 = [0.751365069552];
const MSE = 0.274811083176;
const BCE = 1.380710541466;
const DELTA_OUT = 0.138498561629;
const DW2 = [0.082167040564, 0.082667627848];
const DW1 = [
  [0.000668396021, 0.001336792042],
  [0.000749803774, 0.001499607549],
];
const DB1 = [0.013367920423, 0.014996075489];

describe('the Lesson 2.2 worked example (2-2-1, sigmoid)', () => {
  const pass = forward(WORKED_EXAMPLE, X);

  it('computes the hidden pre-activations by hand', () => {
    // z1_1 = 0.15*0.05 + 0.20*0.10 + 0.35 = 0.0075 + 0.02 + 0.35
    expect(pass.zs[0]![0]).toBeCloseTo(Z1[0]!, 12);
    // z1_2 = 0.25*0.05 + 0.30*0.10 + 0.35 = 0.0125 + 0.03 + 0.35
    expect(pass.zs[0]![1]).toBeCloseTo(Z1[1]!, 12);
  });

  it('matches the hidden activations to 1e-9', () => {
    expect(pass.activations[1]![0]).toBeCloseTo(A1[0]!, 9);
    expect(pass.activations[1]![1]).toBeCloseTo(A1[1]!, 9);
    expect(pass.activations[1]).toEqual(Z1.map(sigmoid));
  });

  it('matches the output pre-activation and output to 1e-9', () => {
    expect(pass.zs[1]![0]).toBeCloseTo(Z2[0]!, 9);
    expect(pass.output[0]).toBeCloseTo(A2[0]!, 9);
  });

  it('caches the input as activations[0] and one z per layer', () => {
    expect(pass.activations[0]).toEqual(X);
    expect(pass.activations).toHaveLength(3);
    expect(pass.zs).toHaveLength(2);
    expect(pass.output).toBe(pass.activations[2]);
  });

  it('predict agrees with forward', () => {
    expect(predict(WORKED_EXAMPLE, X)).toEqual(pass.output);
  });

  it('computes both losses to 1e-9', () => {
    expect(loss('mse', pass.output, Y)).toBeCloseTo(MSE, 9);
    expect(loss('bce', pass.output, Y)).toBeCloseTo(BCE, 9);
  });

  it('produces the hand-computed gradients for MSE', () => {
    const grads = backward(WORKED_EXAMPLE, pass, Y, 'mse');

    // delta_out = (yhat - y) * yhat * (1 - yhat)
    expect(grads.dBiases[1]![0]).toBeCloseTo(DELTA_OUT, 9);
    // dL/dW2 = delta_out * a1
    expect(grads.dWeights[1]![0]![0]).toBeCloseTo(DW2[0]!, 9);
    expect(grads.dWeights[1]![0]![1]).toBeCloseTo(DW2[1]!, 9);
    // dL/dW1 = delta_hidden * x, with delta_hidden = W2^T delta_out * sigma'(z1)
    expect(grads.dWeights[0]![0]![0]).toBeCloseTo(DW1[0]![0]!, 9);
    expect(grads.dWeights[0]![0]![1]).toBeCloseTo(DW1[0]![1]!, 9);
    expect(grads.dWeights[0]![1]![0]).toBeCloseTo(DW1[1]![0]!, 9);
    expect(grads.dWeights[0]![1]![1]).toBeCloseTo(DW1[1]![1]!, 9);
    expect(grads.dBiases[0]![0]).toBeCloseTo(DB1[0]!, 9);
    expect(grads.dBiases[0]![1]).toBeCloseTo(DB1[1]!, 9);
  });

  it('leaves the model untouched (backward returns gradients, it does not step)', () => {
    const before = JSON.stringify(WORKED_EXAMPLE);
    backward(WORKED_EXAMPLE, forward(WORKED_EXAMPLE, X), Y, 'bce');
    expect(JSON.stringify(WORKED_EXAMPLE)).toBe(before);
  });

  it('shows the BCE + sigmoid shortcut: delta collapses to (yhat - y)', () => {
    const grads = backward(WORKED_EXAMPLE, pass, Y, 'bce');
    expect(grads.dBiases[1]![0]).toBeCloseTo(A2[0]! - Y[0]!, 9);
  });
});

describe('loss and lossGradient', () => {
  it('mse is 1/2 (yhat - y)^2 averaged over the outputs', () => {
    expect(loss('mse', [0.8], [1])).toBeCloseTo(0.02, 15);
    expect(loss('mse', [0.8, 0.2], [1, 0])).toBeCloseTo(0.02, 15);
  });

  it('bce is zero for a perfect prediction and large for a confident wrong one', () => {
    expect(loss('bce', [1], [1])).toBeCloseTo(0, 9);
    expect(loss('bce', [0], [1])).toBeGreaterThan(20);
    expect(Number.isFinite(loss('bce', [0], [1]))).toBe(true);
  });

  it('gradients agree with finite differences of the loss itself', () => {
    const eps = 1e-6;
    for (const kind of ['mse', 'bce'] as const) {
      const output = [0.73];
      const numeric =
        (loss(kind, [output[0]! + eps], [1]) - loss(kind, [output[0]! - eps], [1])) / (2 * eps);
      expect(lossGradient(kind, output, [1])[0]).toBeCloseTo(numeric, 7);
    }
  });

  it('rejects mismatched output and target lengths', () => {
    expect(() => loss('mse', [1, 2], [1])).toThrow(/length mismatch/);
  });
});

describe('createMlp', () => {
  it('builds the requested shape with the requested activations', () => {
    const mlp = createMlp({
      layerSizes: [2, 4, 3, 1],
      hiddenActivation: 'tanh',
      outputActivation: 'sigmoid',
      seed: 1,
    });
    expect(mlp.layers.map((l) => l.weights.length)).toEqual([4, 3, 1]);
    expect(mlp.layers.map((l) => l.weights[0]!.length)).toEqual([2, 4, 3]);
    expect(mlp.layers.map((l) => l.activation)).toEqual(['tanh', 'tanh', 'sigmoid']);
    expect(countParameters(mlp)).toBe(4 * 2 + 4 + (3 * 4 + 3) + (1 * 3 + 1));
  });

  it('defaults to sigmoid everywhere and the shared seed', () => {
    const mlp = createMlp({ layerSizes: [2, 2, 1] });
    expect(mlp.layers.map((l) => l.activation)).toEqual(['sigmoid', 'sigmoid']);
    expect(createMlp({ layerSizes: [2, 2, 1] })).toEqual(mlp);
  });

  it('initialises weights inside the Xavier limit and biases at zero', () => {
    const mlp = createMlp({ layerSizes: [3, 5, 2], seed: 21 });
    for (const [index, layer] of mlp.layers.entries()) {
      const limit = xavierLimit(mlp.layerSizes[index]!, mlp.layerSizes[index + 1]!);
      for (const row of layer.weights) {
        for (const w of row) {
          expect(Math.abs(w)).toBeLessThanOrEqual(limit);
        }
      }
      expect(layer.biases.every((b) => b === 0)).toBe(true);
    }
  });

  it('gives different networks for different seeds', () => {
    const a = createMlp({ layerSizes: [2, 3, 1], seed: 1 });
    const b = createMlp({ layerSizes: [2, 3, 1], seed: 2 });
    expect(a.layers[0]!.weights).not.toEqual(b.layers[0]!.weights);
  });

  it('is plain JSON data, so it survives a store round-trip', () => {
    const mlp = createMlp({ layerSizes: [2, 3, 1], seed: 8 });
    const revived = JSON.parse(JSON.stringify(mlp)) as Mlp;
    expect(revived).toEqual(mlp);
    expect(predict(revived, [0.2, 0.4])).toEqual(predict(mlp, [0.2, 0.4]));
  });

  it('rejects malformed layer sizes', () => {
    expect(() => createMlp({ layerSizes: [2] })).toThrow(/at least an input and an output/);
    expect(() => createMlp({ layerSizes: [2, 0, 1] })).toThrow(/positive integers/);
    expect(() => createMlp({ layerSizes: [2, 1.5, 1] })).toThrow(/positive integers/);
  });
});

describe('forward and clone', () => {
  it('rejects an input of the wrong width', () => {
    expect(() => forward(createMlp({ layerSizes: [2, 2, 1] }), [1, 2, 3])).toThrow(
      /expected 2 inputs/,
    );
  });

  it('clone produces an independent deep copy', () => {
    const mlp = createMlp({ layerSizes: [2, 3, 1], seed: 6 });
    const copy = clone(mlp);
    expect(copy).toEqual(mlp);
    copy.layers[0]!.weights[0]![0] = 42;
    copy.layers[0]!.biases[0] = 42;
    copy.layerSizes[0] = 99;
    expect(mlp.layers[0]!.weights[0]![0]).not.toBe(42);
    expect(mlp.layers[0]!.biases[0]).toBe(0);
    expect(mlp.layerSizes[0]).toBe(2);
  });
});
