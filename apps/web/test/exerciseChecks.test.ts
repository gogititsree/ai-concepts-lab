import { describe, expect, it } from 'vitest';

import { parseExerciseConfig } from '../src/features/content/exerciseConfig';
import {
  bestRecord,
  evaluateMlpTasks,
  recordedValue,
  type MlpMeasurements,
} from '../src/features/exercises/mlp/checks';
import { evaluatePerceptronTasks } from '../src/features/exercises/perceptron/checks';
import { exerciseDetail } from './fixtures/content';

/**
 * The auto-checks are the only part of an exercise a learner cannot argue with, so they are
 * tested against the *shipped* configs rather than invented ones: if someone edits
 * `content/modules/01-neurons/exercises.json`, these tests are what notices. Since M7 the
 * config arrives the way the API serves it (`test/fixtures/content.ts` reads the same
 * files and reshapes them), not through a bundler glob.
 */

const perceptronConfig = parseExerciseConfig('perceptron', exerciseDetail('neurons').config);
const mlpConfig = parseExerciseConfig('mlp', exerciseDetail('neural-networks').config);

describe('perceptron auto-checks', () => {
  it('passes separate-blobs only at 100 % on the blobs dataset', () => {
    expect(
      evaluatePerceptronTasks(perceptronConfig, {
        dataset: 'blobs',
        accuracy: 1,
        epochsRun: 3,
      }),
    ).toEqual(['separate-blobs']);

    expect(
      evaluatePerceptronTasks(perceptronConfig, {
        dataset: 'blobs',
        accuracy: 0.99,
        epochsRun: 3,
      }),
    ).toEqual([]);
  });

  it('does not count accuracy earned on the wrong dataset', () => {
    expect(
      evaluatePerceptronTasks(perceptronConfig, { dataset: 'xor', accuracy: 1, epochsRun: 1 }),
    ).toEqual([]);
  });

  it('passes try-xor after twenty epochs of XOR, whatever the accuracy did', () => {
    expect(
      evaluatePerceptronTasks(perceptronConfig, {
        dataset: 'xor',
        accuracy: 0.5,
        epochsRun: 20,
      }),
    ).toEqual(['try-xor']);
    expect(
      evaluatePerceptronTasks(perceptronConfig, {
        dataset: 'xor',
        accuracy: 0.75,
        epochsRun: 19,
      }),
    ).toEqual([]);
  });
});

describe('mlp auto-checks', () => {
  const base: MlpMeasurements = {
    dataset: 'xor',
    loss: 0.25,
    accuracy: 0.5,
    epochs: 0,
    singleSteps: 0,
    hiddenSize: 4,
  };

  it('passes xor-converge below the loss target and within the epoch budget', () => {
    expect(evaluateMlpTasks(mlpConfig, { ...base, loss: 0.049, epochs: 120 })).toContain(
      'xor-converge',
    );
    expect(evaluateMlpTasks(mlpConfig, { ...base, loss: 0.051, epochs: 120 })).not.toContain(
      'xor-converge',
    );
  });

  it('treats maxEpochs as a budget that can be blown', () => {
    expect(evaluateMlpTasks(mlpConfig, { ...base, loss: 0.01, epochs: 2001 })).not.toContain(
      'xor-converge',
    );
    expect(evaluateMlpTasks(mlpConfig, { ...base, loss: 0.01, epochs: 2000 })).toContain(
      'xor-converge',
    );
  });

  it('passes circle-hidden-size only above 95 % on circle, and records the size', () => {
    const measurements = { ...base, dataset: 'circle', accuracy: 0.96, hiddenSize: 3 };
    expect(evaluateMlpTasks(mlpConfig, measurements)).toContain('circle-hidden-size');

    const task = mlpConfig.tasks.find(
      (candidate: { id: string }) => candidate.id === 'circle-hidden-size',
    );
    expect(task).toBeDefined();
    expect(recordedValue(task!, measurements)).toBe(3);
    expect(recordedValue(task!, { ...measurements, accuracy: 0.94 })).toBeUndefined();
  });

  it('counts a single forward+backward step for step-through, on any dataset', () => {
    expect(evaluateMlpTasks(mlpConfig, { ...base, singleSteps: 1 })).toContain('step-through');
    expect(evaluateMlpTasks(mlpConfig, { ...base, dataset: 'spiral', singleSteps: 4 })).toContain(
      'step-through',
    );
    expect(evaluateMlpTasks(mlpConfig, base)).not.toContain('step-through');
  });

  it('keeps the smallest hidden size ever recorded', () => {
    expect(bestRecord(undefined, 5)).toBe(5);
    expect(bestRecord(5, 3)).toBe(3);
    expect(bestRecord(3, 6)).toBe(3);
    expect(bestRecord(3, undefined)).toBe(3);
    expect(bestRecord(undefined, undefined)).toBeUndefined();
  });
});
