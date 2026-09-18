import { describe, expect, it } from 'vitest';
import {
  type MlpSample,
  accuracy,
  addGradientsInPlace,
  applyGradients,
  backward,
  createMlp,
  datasetLoss,
  forward,
  loss,
  predict,
  scaleGradientsInPlace,
  toMlpDataset,
  trainEpoch,
  trainStep,
  zeroGradients,
} from '../src/mlp.js';
import { diagonal, xor } from '../src/datasets.js';

const XOR = toMlpDataset(xor());

describe('XOR', () => {
  it('converges to loss < 0.05 within 100 epochs on a fixed seed', () => {
    // A 2-4-1 network with a tanh hidden layer. The whole point of Module 2: a single neuron
    // cannot do this (see perceptron.test.ts) and a hidden layer can.
    const mlp = createMlp({
      layerSizes: [2, 4, 1],
      hiddenActivation: 'tanh',
      outputActivation: 'sigmoid',
      seed: 42,
    });

    expect(datasetLoss(mlp, XOR, 'bce')).toBeGreaterThan(0.5);

    let epochs = 0;
    while (epochs < 100 && datasetLoss(mlp, XOR, 'bce') >= 0.05) {
      trainEpoch(mlp, XOR, 0.5, { loss: 'bce' });
      epochs += 1;
    }

    expect(epochs).toBeLessThanOrEqual(60); // observed: 47
    expect(datasetLoss(mlp, XOR, 'bce')).toBeLessThan(0.05);
    expect(accuracy(mlp, XOR)).toBe(1);
    for (const sample of XOR) {
      expect(Math.round(predict(mlp, sample.x)[0]!)).toBe(sample.y[0]);
    }
  });

  it('also converges with MSE and a sigmoid hidden layer, just slower', () => {
    const mlp = createMlp({
      layerSizes: [2, 4, 1],
      hiddenActivation: 'sigmoid',
      outputActivation: 'sigmoid',
      seed: 42,
    });
    for (let epoch = 0; epoch < 500; epoch += 1) {
      trainEpoch(mlp, XOR, 0.5, { loss: 'mse' });
    }
    expect(datasetLoss(mlp, XOR, 'mse')).toBeLessThan(0.05);
    expect(accuracy(mlp, XOR)).toBe(1);
  });
});

describe('loss decreases monotonically for a small learning rate on a convex problem', () => {
  it('full-batch gradient descent on logistic regression never goes uphill', () => {
    // One layer with a sigmoid output and BCE loss is logistic regression: the loss is convex
    // in the weights, so with full-batch steps and a small enough learning rate every epoch
    // must reduce it. Any increase means the gradient has the wrong sign or scale somewhere.
    const dataset = toMlpDataset(diagonal({ n: 40, seed: 3 }));
    const mlp = createMlp({ layerSizes: [2, 1], outputActivation: 'sigmoid', seed: 5 });

    let previous = datasetLoss(mlp, dataset, 'bce');
    const first = previous;
    for (let epoch = 0; epoch < 300; epoch += 1) {
      trainEpoch(mlp, dataset, 0.05, { batchSize: dataset.length, loss: 'bce' });
      const current = datasetLoss(mlp, dataset, 'bce');
      expect(current).toBeLessThan(previous);
      previous = current;
    }
    expect(previous).toBeLessThan(first * 0.6);
  });
});

describe('trainStep', () => {
  it('returns the loss from before the update, and the update lowers it', () => {
    const mlp = createMlp({ layerSizes: [2, 3, 1], seed: 12 });
    const x = [0.4, -0.2];
    const y = [1];
    const before = loss('mse', predict(mlp, x), y);
    const reported = trainStep(mlp, x, y, 0.5);
    expect(reported).toBeCloseTo(before, 15);
    expect(loss('mse', predict(mlp, x), y)).toBeLessThan(before);
  });

  it('honours the loss kind', () => {
    const mlp = createMlp({ layerSizes: [2, 3, 1], seed: 12 });
    const reported = trainStep(mlp, [0.4, -0.2], [1], 0.5, 'bce');
    expect(reported).toBeGreaterThan(0.3); // a BCE value, not an MSE one
  });
});

describe('trainEpoch', () => {
  const dataset = toMlpDataset(diagonal({ n: 20, seed: 8 }));

  it('returns the mean loss over the dataset', () => {
    const mlp = createMlp({ layerSizes: [2, 3, 1], seed: 2 });
    const expected = datasetLoss(mlp, dataset, 'mse');
    expect(trainEpoch(mlp, dataset, 0)).toBeCloseTo(expected, 15);
  });

  it('with lr = 0 changes nothing', () => {
    const mlp = createMlp({ layerSizes: [2, 3, 1], seed: 2 });
    const before = JSON.stringify(mlp);
    trainEpoch(mlp, dataset, 0);
    expect(JSON.stringify(mlp)).toBe(before);
  });

  it('is deterministic: two identically seeded runs agree exactly', () => {
    const a = createMlp({ layerSizes: [2, 3, 1], seed: 2 });
    const b = createMlp({ layerSizes: [2, 3, 1], seed: 2 });
    for (let epoch = 0; epoch < 20; epoch += 1) {
      trainEpoch(a, dataset, 0.2);
      trainEpoch(b, dataset, 0.2);
    }
    expect(a).toEqual(b);
  });

  it('a full-batch step equals one update with the averaged gradients', () => {
    const batched = createMlp({ layerSizes: [2, 3, 1], seed: 30 });
    const manual = createMlp({ layerSizes: [2, 3, 1], seed: 30 });

    trainEpoch(batched, dataset, 0.3, { batchSize: dataset.length });

    const summed = zeroGradients(manual);
    for (const sample of dataset) {
      addGradientsInPlace(summed, backward(manual, forward(manual, sample.x), sample.y, 'mse'));
    }
    scaleGradientsInPlace(summed, 1 / dataset.length);
    applyGradients(manual, summed, 0.3);

    expect(batched).toEqual(manual);
  });

  it('mini-batches sit between pure SGD and full batch', () => {
    const sizes = [1, 5, dataset.length];
    const losses = sizes.map((batchSize) => {
      const mlp = createMlp({ layerSizes: [2, 4, 1], seed: 19 });
      for (let epoch = 0; epoch < 50; epoch += 1) {
        trainEpoch(mlp, dataset, 0.3, { batchSize });
      }
      return datasetLoss(mlp, dataset, 'mse');
    });
    // All three make progress; only the amount differs.
    for (const value of losses) {
      expect(value).toBeLessThan(0.1);
    }
  });

  it('handles an empty dataset and rejects a nonsensical batch size', () => {
    const mlp = createMlp({ layerSizes: [2, 2, 1] });
    expect(trainEpoch(mlp, [], 0.1)).toBe(0);
    expect(datasetLoss(mlp, [], 'mse')).toBe(0);
    expect(() => trainEpoch(mlp, dataset, 0.1, { batchSize: 0 })).toThrow(/batchSize/);
  });
});

describe('accuracy', () => {
  it('thresholds the output at 0.5 by default', () => {
    const mlp = createMlp({ layerSizes: [2, 2, 1], seed: 1 });
    const dataset: MlpSample[] = [{ x: [0, 0], y: [predict(mlp, [0, 0])[0]! >= 0.5 ? 1 : 0] }];
    expect(accuracy(mlp, dataset)).toBe(1);
    expect(accuracy(mlp, [{ x: [0, 0], y: [predict(mlp, [0, 0])[0]! >= 0.5 ? 0 : 1] }])).toBe(0);
  });

  it('accepts a custom threshold and scores an empty dataset as 1', () => {
    const mlp = createMlp({ layerSizes: [2, 2, 1], seed: 1 });
    expect(accuracy(mlp, [{ x: [0, 0], y: [0] }], 1.1)).toBe(1);
    expect(accuracy(mlp, [])).toBe(1);
  });
});

describe('toMlpDataset', () => {
  it('wraps 0/1 labels into one-element target vectors', () => {
    expect(toMlpDataset(xor())).toEqual([
      { x: [-1, -1], y: [0] },
      { x: [-1, 1], y: [1] },
      { x: [1, -1], y: [1] },
      { x: [1, 1], y: [0] },
    ]);
  });
});
