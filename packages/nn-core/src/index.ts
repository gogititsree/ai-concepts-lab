/**
 * Framework-free ML math for AI Concepts Lab.
 *
 * Zero runtime dependencies on purpose: this package is imported both by the browser
 * (visualisations) and by Vitest (numerical tests), so the code that draws a decision boundary
 * is the code the tests prove correct.
 *
 * Module map:
 *   random.ts       seeded PRNG -- everything reproducible goes through it
 *   linalg.ts       vectors and matrices as plain arrays
 *   activations.ts  sigmoid / tanh / relu / step with derivatives, plus a stable softmax
 *   perceptron.ts   Module 1: one neuron and the perceptron rule
 *   mlp.ts          Module 2: forward, loss, backprop, gradient descent
 *   gradcheck.ts    Module 2: finite differences that prove backprop right
 *   datasets.ts     seeded 2-D toy datasets
 *   bpe.ts          Module 3: byte-pair encoding
 *   attention.ts    Module 3: scaled dot-product attention
 *   pca.ts          Module 3: PCA by power iteration, cosine similarity
 */

export * from './random.js';
export * from './linalg.js';
export * from './activations.js';
export * from './datasets.js';
export * from './bpe.js';
export * from './attention.js';
export * from './pca.js';
export * from './gradcheck.js';

/**
 * `perceptron` and `mlp` deliberately use the same verbs -- `predict`, `trainStep`,
 * `trainEpoch`, `accuracy`, `clone` -- because they are the same ideas at two scales, and the
 * lessons read better that way. At the package boundary that would collide, so each module is
 * also exported as a namespace and the flat names are prefixed.
 */
export * as perceptron from './perceptron.js';
export * as mlp from './mlp.js';

export {
  createPerceptron,
  decisionLine,
  netInput as perceptronNetInput,
  predict as perceptronPredict,
  trainStep as perceptronTrainStep,
  trainEpoch as perceptronTrainEpoch,
  accuracy as perceptronAccuracy,
  clone as clonePerceptron,
} from './perceptron.js';
export type { LabeledSample, Perceptron, DecisionLine, Point } from './perceptron.js';

export {
  createMlp,
  xavierLimit,
  countParameters,
  forward,
  loss,
  lossGradient,
  zeroGradients,
  backward,
  applyGradients,
  addGradientsInPlace,
  scaleGradientsInPlace,
  datasetLoss,
  toMlpDataset,
  predict as mlpPredict,
  trainStep as mlpTrainStep,
  trainEpoch as mlpTrainEpoch,
  accuracy as mlpAccuracy,
  clone as cloneMlp,
} from './mlp.js';
export type {
  ForwardPass,
  Gradients,
  HiddenActivationKind,
  LossKind,
  Mlp,
  MlpLayer,
  MlpOptions,
  MlpSample,
  OutputActivationKind,
  TrainEpochOptions,
} from './mlp.js';
