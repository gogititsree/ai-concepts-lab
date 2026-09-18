import { describe, expect, it } from 'vitest';
import {
  ACTIVATIONS,
  type ActivationKind,
  applyActivation,
  applyActivationDerivative,
  getActivation,
  relu,
  reluPrime,
  sigmoid,
  sigmoidPrime,
  softmax,
  step,
  stepPrime,
  tanh,
  tanhPrime,
} from '../src/activations.js';

describe('sigmoid', () => {
  it('maps 0 to 1/2 and is symmetric about it', () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(2) + sigmoid(-2)).toBeCloseTo(1, 15);
  });

  it('matches known values', () => {
    expect(sigmoid(0.3775)).toBeCloseTo(0.593269992107, 12);
    expect(sigmoid(1)).toBeCloseTo(0.7310585786300049, 15);
  });

  it('saturates without overflowing at either extreme', () => {
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(Number.isNaN(sigmoid(-1e308))).toBe(false);
  });

  it('derivative equals s(1 - s) and peaks at z = 0', () => {
    expect(sigmoidPrime(0)).toBeCloseTo(0.25, 15);
    expect(sigmoidPrime(2)).toBeCloseTo(sigmoid(2) * (1 - sigmoid(2)), 15);
    expect(sigmoidPrime(10)).toBeLessThan(sigmoidPrime(1));
  });
});

describe('tanh', () => {
  it('maps 0 to 0 and is odd', () => {
    expect(tanh(0)).toBe(0);
    expect(tanh(-1.3)).toBeCloseTo(-tanh(1.3), 15);
  });

  it('derivative equals 1 - tanh^2 and peaks at 1', () => {
    expect(tanhPrime(0)).toBe(1);
    expect(tanhPrime(0.5)).toBeCloseTo(1 - Math.tanh(0.5) ** 2, 15);
  });
});

describe('relu and step', () => {
  it('relu passes positives and zeroes the rest', () => {
    expect([relu(2), relu(0), relu(-2)]).toEqual([2, 0, 0]);
    expect([reluPrime(2), reluPrime(0), reluPrime(-2)]).toEqual([1, 0, 0]);
  });

  it('step uses the z >= 0 -> 1 convention from the Module 1 quiz', () => {
    expect([step(0.1), step(0), step(-0.1)]).toEqual([1, 1, 0]);
  });

  it("step's derivative is zero everywhere, which is why gradient descent cannot train it", () => {
    expect([stepPrime(-1), stepPrime(0), stepPrime(1)]).toEqual([0, 0, 0]);
  });
});

describe('derivatives against central finite differences', () => {
  const eps = 1e-6;
  const kinds: ActivationKind[] = ['sigmoid', 'tanh', 'relu'];

  it.each(kinds)('%s', (kind) => {
    const { fn, derivative } = getActivation(kind);
    for (const z of [-2.3, -0.7, 0.4, 1.9]) {
      const numeric = (fn(z + eps) - fn(z - eps)) / (2 * eps);
      expect(derivative(z)).toBeCloseTo(numeric, 7);
    }
  });
});

describe('the activation registry', () => {
  it('exposes every kind with a matching name', () => {
    for (const [key, activation] of Object.entries(ACTIVATIONS)) {
      expect(activation.name).toBe(key);
    }
  });

  it('applies functions and derivatives element-wise', () => {
    expect(applyActivation('relu', [-1, 0, 2])).toEqual([0, 0, 2]);
    expect(applyActivationDerivative('relu', [-1, 0, 2])).toEqual([0, 0, 1]);
  });

  it('fails loudly on an unknown kind coming from config', () => {
    expect(() => getActivation('softplus' as ActivationKind)).toThrow(/unknown activation/);
  });
});

describe('softmax', () => {
  it('produces a probability distribution', () => {
    const probabilities = softmax([1, 2, 3]);
    expect(probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15);
    expect(probabilities[2]).toBeGreaterThan(probabilities[1]!);
    expect(probabilities.every((p) => p > 0 && p < 1)).toBe(true);
  });

  it('is stable for large inputs, where a naive implementation returns NaN', () => {
    const probabilities = softmax([1000, 1001, 1002]);
    expect(probabilities.every(Number.isFinite)).toBe(true);
    expect(probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15);
    // Shifting every score by a constant must not change the answer.
    expect(probabilities).toEqual(softmax([0, 1, 2]));
  });

  it('is stable for large negative inputs too', () => {
    const probabilities = softmax([-1000, -1001]);
    expect(probabilities.every(Number.isFinite)).toBe(true);
    expect(probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15);
  });

  it('is uniform for equal scores', () => {
    expect(softmax([5, 5, 5, 5])).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it('returns an empty distribution for an empty input', () => {
    expect(softmax([])).toEqual([]);
  });
});
