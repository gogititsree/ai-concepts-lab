import { describe, expect, it } from 'vitest';
import {
  accuracy,
  clone,
  createPerceptron,
  decisionLine,
  netInput,
  predict,
  trainEpoch,
  trainStep,
} from '../src/perceptron.js';
import { diagonal, xor } from '../src/datasets.js';
import { createRng } from '../src/random.js';

describe('predict', () => {
  it('answers the Module 1 quiz question: w = (2, -1), b = -1, x = (1, 1) -> 1', () => {
    const p = { weights: [2, -1], bias: -1 };
    expect(netInput(p, [1, 1])).toBe(0);
    // z = 0 and the convention is z >= 0 -> 1, which is the whole point of the question.
    expect(predict(p, [1, 1])).toBe(1);
  });

  it('reads the sign of w . x + b', () => {
    const p = { weights: [1, 0], bias: 0 };
    expect(predict(p, [0.5, 99])).toBe(1);
    expect(predict(p, [-0.5, 99])).toBe(0);
  });
});

describe('createPerceptron', () => {
  it('is reproducible for a given seed and sized to the input', () => {
    const a = createPerceptron(3, createRng(9));
    const b = createPerceptron(3, createRng(9));
    expect(a).toEqual(b);
    expect(a.weights).toHaveLength(3);
  });

  it('starts with small weights in [-0.5, 0.5)', () => {
    const p = createPerceptron(5, createRng(3));
    for (const w of [...p.weights, p.bias]) {
      expect(w).toBeGreaterThanOrEqual(-0.5);
      expect(w).toBeLessThan(0.5);
    }
  });

  it('defaults to the shared seed when no rng is supplied', () => {
    expect(createPerceptron(2)).toEqual(createPerceptron(2));
  });

  it('rejects a non-positive input size', () => {
    expect(() => createPerceptron(0)).toThrow(RangeError);
  });
});

describe('trainStep', () => {
  it('does nothing when the prediction is already right', () => {
    const p = { weights: [1, 1], bias: 0 };
    const before = clone(p);
    expect(trainStep(p, [1, 1], 1, 0.1)).toBe(false);
    expect(p).toEqual(before);
  });

  it('nudges the weights towards the example when it is wrong', () => {
    // z = -1 so yhat = 0, but y = 1: w += lr * (1 - 0) * x, b += lr.
    const p = { weights: [0, 0], bias: -1 };
    expect(trainStep(p, [2, 3], 1, 0.5)).toBe(true);
    expect(p.weights).toEqual([1, 1.5]);
    expect(p.bias).toBe(-0.5);
  });

  it('pushes the other way for a false positive', () => {
    const p = { weights: [1, 1], bias: 0 };
    expect(trainStep(p, [1, 1], 0, 0.25)).toBe(true);
    expect(p.weights).toEqual([0.75, 0.75]);
    expect(p.bias).toBe(-0.25);
  });
});

describe('learning', () => {
  it('reaches 100 % on the linearly separable diagonal dataset', () => {
    const dataset = diagonal({ n: 60, seed: 9 });
    const p = createPerceptron(2, createRng(4));
    expect(accuracy(p, dataset)).toBeLessThan(1); // it genuinely starts wrong

    let epochs = 0;
    while (epochs < 100 && accuracy(p, dataset) < 1) {
      trainEpoch(p, dataset, 0.1);
      epochs += 1;
    }

    expect(accuracy(p, dataset)).toBe(1);
    expect(epochs).toBeLessThanOrEqual(50);
  });

  it('reports zero misclassifications once it has converged', () => {
    const dataset = diagonal({ n: 30, seed: 2 });
    const p = createPerceptron(2, createRng(4));
    for (let i = 0; i < 100; i += 1) {
      trainEpoch(p, dataset, 0.1);
    }
    expect(trainEpoch(p, dataset, 0.1)).toBe(0);
  });

  it('never reaches 100 % on XOR, even after 50 epochs', () => {
    // This is the experimental version of "a single line cannot separate XOR", and the
    // cliffhanger that Module 2 resolves.
    const dataset = xor();
    const p = createPerceptron(2, createRng(1));
    let best = accuracy(p, dataset);
    for (let epoch = 0; epoch < 50; epoch += 1) {
      trainEpoch(p, dataset, 0.1);
      best = Math.max(best, accuracy(p, dataset));
    }
    expect(best).toBeLessThan(1);
    expect(accuracy(p, dataset)).toBeLessThanOrEqual(0.75);
  });

  it('scores an empty dataset as 1 rather than dividing by zero', () => {
    expect(accuracy({ weights: [1, 1], bias: 0 }, [])).toBe(1);
  });
});

describe('clone', () => {
  it('detaches the copy from the original', () => {
    const p = { weights: [1, 2], bias: 3 };
    const copy = clone(p);
    copy.weights[0] = 99;
    copy.bias = 99;
    expect(p).toEqual({ weights: [1, 2], bias: 3 });
  });
});

describe('decisionLine', () => {
  it('turns weights into slope/intercept and two drawable points', () => {
    // x1 + x2 - 1 = 0  ->  x2 = -x1 + 1
    const line = decisionLine({ weights: [1, 1], bias: -1 }, -1, 1);
    expect(line.kind).toBe('sloped');
    if (line.kind !== 'sloped') return;
    expect(line.slope).toBe(-1);
    expect(line.intercept).toBe(1);
    expect(line.points).toEqual([
      [-1, 2],
      [1, 0],
    ]);
  });

  it('every point on the returned line has net input 0', () => {
    const p = { weights: [0.3, -1.4], bias: 0.2 };
    const line = decisionLine(p);
    expect(line.kind).toBe('sloped');
    if (line.kind !== 'sloped') return;
    for (const point of line.points) {
      expect(netInput(p, point)).toBeCloseTo(0, 12);
    }
  });

  it('handles the vertical case where w2 is 0', () => {
    const line = decisionLine({ weights: [2, 0], bias: -1 }, -1, 1);
    expect(line.kind).toBe('vertical');
    if (line.kind !== 'vertical') return;
    expect(line.x).toBe(0.5);
    expect(line.points).toEqual([
      [0.5, -1],
      [0.5, 1],
    ]);
  });

  it('reports no line when both weights are zero', () => {
    expect(decisionLine({ weights: [0, 0], bias: 1 })).toEqual({ kind: 'none' });
  });

  it('refuses to draw a line for a non-2-D perceptron', () => {
    expect(() => decisionLine({ weights: [1, 2, 3], bias: 0 })).toThrow(/2-D/);
  });
});
