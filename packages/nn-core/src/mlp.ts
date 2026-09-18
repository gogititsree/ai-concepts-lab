/**
 * A multilayer perceptron: forward pass, loss, backpropagation, gradient descent.
 *
 * Shapes and conventions used throughout:
 *   - `layers[l].weights[j][i]` connects input `i` of layer `l` to unit `j` of layer `l`.
 *   - `z[l] = W[l] a[l-1] + b[l]` and `a[l] = act(z[l])`, with `a[-1]` being the input `x`.
 *   - `cache.activations[0]` is the input, so `cache.activations[l]` is the *input* to layer
 *     `l` and `cache.activations[l + 1]` is its output. `cache.zs[l]` is layer `l`'s
 *     pre-activation.
 *
 * The model is plain data (arrays, numbers, strings -- no classes, no closures), so it can be
 * put in a Zustand store, JSON.stringify'd into `user_exercise_progress.state`, and read back
 * with no revival step.
 */

import { type ActivationKind, applyActivation, getActivation } from './activations.js';
import { addInPlace, dot, scaleInPlace, zeros, zerosMatrix } from './linalg.js';
import { type Rng, createRng, DEFAULT_SEED } from './random.js';

export type LossKind = 'mse' | 'bce';
export type HiddenActivationKind = Extract<ActivationKind, 'sigmoid' | 'tanh' | 'relu'>;
export type OutputActivationKind = HiddenActivationKind;

export interface MlpLayer {
  /** `weights[unit][input]`, so each row is one unit's incoming weights. */
  weights: number[][];
  biases: number[];
  activation: ActivationKind;
}

export interface Mlp {
  /** e.g. `[2, 4, 1]`: two inputs, one hidden layer of four units, one output. */
  layerSizes: number[];
  hiddenActivation: HiddenActivationKind;
  outputActivation: OutputActivationKind;
  /** Kept so the UI can show, and reproduce, the initialisation. */
  seed: number;
  layers: MlpLayer[];
}

export interface MlpOptions {
  layerSizes: number[];
  hiddenActivation?: HiddenActivationKind;
  outputActivation?: OutputActivationKind;
  seed?: number;
}

/** A training example for a network: an input vector and a target vector. */
export interface MlpSample {
  x: readonly number[];
  y: readonly number[];
}

/** Everything the backward pass needs from the forward pass. */
export interface ForwardPass {
  /** The network's output, i.e. the last entry of `activations`. */
  output: number[];
  /** `zs[l]` is layer `l`'s pre-activation. Length = number of layers. */
  zs: number[][];
  /** `activations[0]` is the input; length = number of layers + 1. */
  activations: number[][];
}

/** Gradients with the same shape as the parameters: `dWeights[l][unit][input]`. */
export interface Gradients {
  dWeights: number[][][];
  dBiases: number[][];
}

/**
 * Xavier/Glorot uniform initialisation: U(-limit, limit) with
 * limit = sqrt(6 / (fanIn + fanOut)).
 *
 * The point is to keep the variance of the activations roughly constant as signals move
 * through the layers; too large and sigmoid/tanh saturate (gradients vanish), too small and
 * the signal dies out. Biases start at zero -- there is no symmetry to break in a bias.
 */
export function xavierLimit(fanIn: number, fanOut: number): number {
  return Math.sqrt(6 / (fanIn + fanOut));
}

export function createMlp(options: MlpOptions): Mlp {
  const {
    layerSizes,
    hiddenActivation = 'sigmoid',
    outputActivation = 'sigmoid',
    seed = DEFAULT_SEED,
  } = options;

  if (layerSizes.length < 2) {
    throw new RangeError('createMlp: layerSizes needs at least an input and an output size');
  }
  if (layerSizes.some((size) => !Number.isInteger(size) || size < 1)) {
    throw new RangeError(`createMlp: layer sizes must be positive integers, got [${layerSizes}]`);
  }

  const rng: Rng = createRng(seed);
  const layers: MlpLayer[] = [];

  for (let l = 1; l < layerSizes.length; l += 1) {
    const fanIn = layerSizes[l - 1]!;
    const fanOut = layerSizes[l]!;
    const limit = xavierLimit(fanIn, fanOut);
    const isOutputLayer = l === layerSizes.length - 1;
    layers.push({
      // Unit-major draw order; changing it would change every seeded fixture in the tests.
      weights: Array.from({ length: fanOut }, () =>
        Array.from({ length: fanIn }, () => rng.range(-limit, limit)),
      ),
      biases: zeros(fanOut),
      activation: isOutputLayer ? outputActivation : hiddenActivation,
    });
  }

  return { layerSizes: [...layerSizes], hiddenActivation, outputActivation, seed, layers };
}

/** Deep copy. Used by the gradient checker so probing never disturbs the real model. */
export function clone(mlp: Mlp): Mlp {
  return {
    layerSizes: [...mlp.layerSizes],
    hiddenActivation: mlp.hiddenActivation,
    outputActivation: mlp.outputActivation,
    seed: mlp.seed,
    layers: mlp.layers.map((layer) => ({
      weights: layer.weights.map((row) => [...row]),
      biases: [...layer.biases],
      activation: layer.activation,
    })),
  };
}

/** Total number of trainable parameters (weights + biases). */
export function countParameters(mlp: Mlp): number {
  return mlp.layers.reduce(
    (total, layer) =>
      total + layer.weights.reduce((n, row) => n + row.length, 0) + layer.biases.length,
    0,
  );
}

/**
 * Run the network forward, keeping every intermediate value.
 *
 * The cache is not an optimisation: backprop literally needs `a[l-1]` to form `dL/dW[l]` and
 * `z[l]` to evaluate the activation's derivative, so the forward pass has to hand them over.
 */
export function forward(mlp: Mlp, x: readonly number[]): ForwardPass {
  const inputSize = mlp.layerSizes[0]!;
  if (x.length !== inputSize) {
    throw new RangeError(`forward: expected ${inputSize} inputs, got ${x.length}`);
  }

  const activations: number[][] = [[...x]];
  const zs: number[][] = [];

  for (const layer of mlp.layers) {
    const previous = activations[activations.length - 1]!;
    const z = layer.weights.map((row, j) => dot(row, previous) + layer.biases[j]!);
    zs.push(z);
    activations.push(applyActivation(layer.activation, z));
  }

  return { output: activations[activations.length - 1]!, zs, activations };
}

/** Just the output, for when the caller does not need the cache. */
export function predict(mlp: Mlp, x: readonly number[]): number[] {
  return forward(mlp, x).output;
}

/** Clamp probabilities away from 0 and 1 so Math.log never returns -Infinity. */
const BCE_EPSILON = 1e-12;

function clampProbability(p: number): number {
  return Math.min(1 - BCE_EPSILON, Math.max(BCE_EPSILON, p));
}

/**
 * Loss, averaged over the output units.
 *
 *   - `mse`: mean(0.5 * (yhat - y)^2). The 1/2 is the usual bookkeeping trick that cancels
 *     the 2 from the derivative, and matches the L = 1/2 (y - yhat)^2 in Lesson 2.2.
 *   - `bce`: mean(-(y log yhat + (1 - y) log(1 - yhat))), the right loss for a sigmoid
 *     output read as a probability.
 */
export function loss(kind: LossKind, output: readonly number[], target: readonly number[]): number {
  if (output.length !== target.length) {
    throw new RangeError(
      `loss: output/target length mismatch (${output.length} vs ${target.length})`,
    );
  }
  const n = output.length;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const yHat = output[i]!;
    const y = target[i]!;
    if (kind === 'mse') {
      const diff = yHat - y;
      total += 0.5 * diff * diff;
    } else {
      const p = clampProbability(yHat);
      total += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }
  }
  return total / n;
}

/**
 * dL/dyhat, the only place the choice of loss enters backprop.
 *
 * For `bce` this is (yhat - y) / (yhat (1 - yhat)) / n. Multiplying it by the sigmoid
 * derivative yhat (1 - yhat) in `backward` cancels the denominator and leaves the famous
 * delta = (yhat - y) / n. Keeping the two factors separate costs a little precision but means
 * loss and activation stay independent -- and the gradient check then proves the chain rule is
 * applied correctly rather than baking in the shortcut.
 */
export function lossGradient(
  kind: LossKind,
  output: readonly number[],
  target: readonly number[],
): number[] {
  const n = output.length;
  return output.map((yHat, i) => {
    const y = target[i]!;
    if (kind === 'mse') {
      return (yHat - y) / n;
    }
    const p = clampProbability(yHat);
    return (p - y) / (p * (1 - p)) / n;
  });
}

/** Zero-filled gradients shaped like `mlp`'s parameters. */
export function zeroGradients(mlp: Mlp): Gradients {
  return {
    dWeights: mlp.layers.map((layer) =>
      zerosMatrix(layer.weights.length, layer.weights[0]!.length),
    ),
    dBiases: mlp.layers.map((layer) => zeros(layer.biases.length)),
  };
}

/**
 * Backpropagation. Returns gradients; does not touch the model.
 *
 * Output layer:  delta[L] = dL/dyhat * act'(z[L])
 * Hidden layers: delta[l] = (W[l+1]^T delta[l+1]) * act'(z[l])
 * Parameters:    dL/dW[l] = delta[l] a[l-1]^T and dL/db[l] = delta[l]
 */
export function backward(
  mlp: Mlp,
  cache: ForwardPass,
  target: readonly number[],
  lossKind: LossKind = 'mse',
): Gradients {
  const layerCount = mlp.layers.length;
  const grads = zeroGradients(mlp);

  const outputLayer = mlp.layers[layerCount - 1]!;
  const outputZ = cache.zs[layerCount - 1]!;
  const dLdOutput = lossGradient(lossKind, cache.output, target);
  const outputDerivative = getActivation(outputLayer.activation).derivative;
  let delta = dLdOutput.map((value, j) => value * outputDerivative(outputZ[j]!));

  for (let l = layerCount - 1; l >= 0; l -= 1) {
    const layer = mlp.layers[l]!;
    const inputs = cache.activations[l]!;
    const dW = grads.dWeights[l]!;
    const dB = grads.dBiases[l]!;

    for (let j = 0; j < delta.length; j += 1) {
      const deltaJ = delta[j]!;
      dB[j] = deltaJ;
      const row = dW[j]!;
      for (let i = 0; i < inputs.length; i += 1) {
        row[i] = deltaJ * inputs[i]!;
      }
    }

    if (l > 0) {
      // Push the error back through the transpose of this layer's weights, then multiply by
      // the previous layer's local slope.
      const previousLayer = mlp.layers[l - 1]!;
      const previousZ = cache.zs[l - 1]!;
      const previousDerivative = getActivation(previousLayer.activation).derivative;
      const next = zeros(inputs.length);
      for (let j = 0; j < delta.length; j += 1) {
        const deltaJ = delta[j]!;
        const row = layer.weights[j]!;
        for (let i = 0; i < next.length; i += 1) {
          next[i]! += row[i]! * deltaJ;
        }
      }
      for (let i = 0; i < next.length; i += 1) {
        next[i]! *= previousDerivative(previousZ[i]!);
      }
      delta = next;
    }
  }

  return grads;
}

/** theta <- theta - lr * dL/dtheta, mutating `mlp` and returning it. */
export function applyGradients(mlp: Mlp, grads: Gradients, lr: number): Mlp {
  for (let l = 0; l < mlp.layers.length; l += 1) {
    const layer = mlp.layers[l]!;
    const dW = grads.dWeights[l]!;
    const dB = grads.dBiases[l]!;
    for (let j = 0; j < layer.weights.length; j += 1) {
      const row = layer.weights[j]!;
      const dRow = dW[j]!;
      for (let i = 0; i < row.length; i += 1) {
        row[i]! -= lr * dRow[i]!;
      }
      layer.biases[j]! -= lr * dB[j]!;
    }
  }
  return mlp;
}

/** Add `source` into `target` in place; used to sum gradients over a mini-batch. */
export function addGradientsInPlace(target: Gradients, source: Gradients): Gradients {
  for (let l = 0; l < target.dWeights.length; l += 1) {
    const dW = target.dWeights[l]!;
    const sW = source.dWeights[l]!;
    for (let j = 0; j < dW.length; j += 1) {
      addInPlace(dW[j]!, sW[j]!);
    }
    addInPlace(target.dBiases[l]!, source.dBiases[l]!);
  }
  return target;
}

/** Multiply every gradient entry by `scalar` in place; used to average a mini-batch. */
export function scaleGradientsInPlace(grads: Gradients, scalar: number): Gradients {
  for (let l = 0; l < grads.dWeights.length; l += 1) {
    for (const row of grads.dWeights[l]!) {
      scaleInPlace(row, scalar);
    }
    scaleInPlace(grads.dBiases[l]!, scalar);
  }
  return grads;
}

/**
 * One example: forward, backward, update. Returns the loss *before* the update, which is the
 * value worth plotting (it is the loss the gradient was computed from).
 */
export function trainStep(
  mlp: Mlp,
  x: readonly number[],
  y: readonly number[],
  lr: number,
  lossKind: LossKind = 'mse',
): number {
  const cache = forward(mlp, x);
  const value = loss(lossKind, cache.output, y);
  applyGradients(mlp, backward(mlp, cache, y, lossKind), lr);
  return value;
}

export interface TrainEpochOptions {
  /** Examples per update. Defaults to 1 (pure SGD); `dataset.length` gives full-batch GD. */
  batchSize?: number;
  loss?: LossKind;
}

/**
 * One pass over the dataset, returning the mean loss across it.
 *
 * The dataset is consumed in the order given -- no internal shuffling. Shuffling is a caller's
 * decision precisely because it needs a seeded `Rng` to stay reproducible, and a silent
 * `Math.random()` in here would make every test flaky.
 */
export function trainEpoch(
  mlp: Mlp,
  dataset: readonly MlpSample[],
  lr: number,
  options: TrainEpochOptions = {},
): number {
  const { batchSize = 1, loss: lossKind = 'mse' } = options;
  if (batchSize < 1) {
    throw new RangeError(`trainEpoch: batchSize must be >= 1, got ${batchSize}`);
  }
  if (dataset.length === 0) {
    return 0;
  }

  let totalLoss = 0;
  for (let start = 0; start < dataset.length; start += batchSize) {
    const batch = dataset.slice(start, start + batchSize);
    const summed = zeroGradients(mlp);
    for (const sample of batch) {
      const cache = forward(mlp, sample.x);
      totalLoss += loss(lossKind, cache.output, sample.y);
      addGradientsInPlace(summed, backward(mlp, cache, sample.y, lossKind));
    }
    // Average over the batch so the effective step size does not depend on batch size.
    scaleGradientsInPlace(summed, 1 / batch.length);
    applyGradients(mlp, summed, lr);
  }
  return totalLoss / dataset.length;
}

/** Mean loss over a dataset without touching the weights. */
export function datasetLoss(
  mlp: Mlp,
  dataset: readonly MlpSample[],
  lossKind: LossKind = 'mse',
): number {
  if (dataset.length === 0) {
    return 0;
  }
  let total = 0;
  for (const sample of dataset) {
    total += loss(lossKind, predict(mlp, sample.x), sample.y);
  }
  return total / dataset.length;
}

/** Fraction correct, thresholding each output unit. Meant for the single-output case. */
export function accuracy(mlp: Mlp, dataset: readonly MlpSample[], threshold = 0.5): number {
  if (dataset.length === 0) {
    return 1;
  }
  let correct = 0;
  for (const sample of dataset) {
    const output = predict(mlp, sample.x);
    if (output.every((value, i) => (value >= threshold ? 1 : 0) === sample.y[i])) {
      correct += 1;
    }
  }
  return correct / dataset.length;
}

/** Adapt a 0/1-labelled 2-D dataset to the vector-target form the MLP trains on. */
export function toMlpDataset(points: readonly { x: readonly number[]; y: 0 | 1 }[]): MlpSample[] {
  return points.map((point) => ({ x: [...point.x], y: [point.y] }));
}
