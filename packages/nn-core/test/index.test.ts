/**
 * Guards the package's public surface. `apps/web` imports from `@lab/nn-core`, so a rename
 * here is a breaking change for the exercises, and the prefixed aliases exist only because
 * `perceptron` and `mlp` share verbs.
 */

import { describe, expect, it } from 'vitest';
import * as nn from '../src/index.js';

describe('the public API', () => {
  it('exports every module through the barrel', () => {
    const expected = [
      // random
      'createRng',
      'DEFAULT_SEED',
      // linalg
      'zeros',
      'zerosMatrix',
      'shape',
      'cloneMatrix',
      'dot',
      'add',
      'subtract',
      'scale',
      'multiply',
      'addInPlace',
      'scaleInPlace',
      'matVec',
      'transpose',
      'matMul',
      'outer',
      'sum',
      'mean',
      'norm',
      'normalize',
      'argMax',
      'columnMeans',
      // activations
      'sigmoid',
      'sigmoidPrime',
      'tanh',
      'tanhPrime',
      'relu',
      'reluPrime',
      'step',
      'stepPrime',
      'ACTIVATIONS',
      'getActivation',
      'applyActivation',
      'applyActivationDerivative',
      'softmax',
      // perceptron
      'createPerceptron',
      'perceptronPredict',
      'perceptronTrainStep',
      'perceptronTrainEpoch',
      'perceptronAccuracy',
      'perceptronNetInput',
      'clonePerceptron',
      'decisionLine',
      // mlp
      'createMlp',
      'xavierLimit',
      'countParameters',
      'forward',
      'loss',
      'lossGradient',
      'zeroGradients',
      'backward',
      'applyGradients',
      'addGradientsInPlace',
      'scaleGradientsInPlace',
      'datasetLoss',
      'toMlpDataset',
      'mlpPredict',
      'mlpTrainStep',
      'mlpTrainEpoch',
      'mlpAccuracy',
      'cloneMlp',
      // gradcheck
      'gradientCheck',
      'relativeError',
      // datasets
      'DATASET_KINDS',
      'makeDataset',
      'blobs',
      'diagonal',
      'xor',
      'xorNoisy',
      'circle',
      'moons',
      'spiral',
      // bpe
      'trainBpe',
      'encode',
      'encodeToTokens',
      'decode',
      'tokensForIds',
      'detokenize',
      'renderToken',
      'normalizeWhitespace',
      'utf8Length',
      'bytesPerToken',
      'END_OF_WORD',
      'UNKNOWN_TOKEN',
      // attention
      'scaledDotProductAttention',
      'softmaxRows',
      // pca
      'pca',
      'project',
      'cosineSimilarity',
    ];

    for (const name of expected) {
      expect(nn, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("replaces M1's placeholder add(a: number, b: number) with the linalg vector helper", () => {
    expect(nn.add([1, 2], [3, 4])).toEqual([4, 6]);
    // @ts-expect-error - the scaffold's numeric add is gone; this one takes vectors
    expect(() => nn.add(2, 3)).toThrow(TypeError);
  });

  it('also exposes perceptron and mlp as namespaces with their unprefixed names', () => {
    expect(typeof nn.perceptron.predict).toBe('function');
    expect(typeof nn.mlp.predict).toBe('function');
    expect(nn.perceptron.predict).toBe(nn.perceptronPredict);
    expect(nn.mlp.trainEpoch).toBe(nn.mlpTrainEpoch);
    expect(nn.perceptron.clone).toBe(nn.clonePerceptron);
    expect(nn.mlp.clone).toBe(nn.cloneMlp);
  });

  it('runs an end-to-end slice through the barrel', () => {
    const mlp = nn.createMlp({ layerSizes: [2, 4, 1], hiddenActivation: 'tanh', seed: 42 });
    expect(nn.gradientCheck(mlp, [1, -1], [1], 'bce').maxRelativeError).toBeLessThan(1e-6);

    const dataset = nn.toMlpDataset(nn.xor());
    for (let epoch = 0; epoch < 200; epoch += 1) {
      nn.mlpTrainEpoch(mlp, dataset, 0.5, { loss: 'bce' });
    }
    expect(nn.mlpAccuracy(mlp, dataset)).toBe(1);
  });
});
