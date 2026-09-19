import type { ExerciseConfigSchemas } from '@lab/shared';
import type { z } from 'zod';

import { meetsExactly, satisfiesComparison } from '../checkRules';

export type PerceptronConfig = z.infer<(typeof ExerciseConfigSchemas)['perceptron']>;
export type PerceptronTask = PerceptronConfig['tasks'][number];

/**
 * Everything a perceptron task can be checked against. Deliberately a flat bag of numbers
 * rather than the store: the auto-checks are pure, so they are unit-tested directly
 * (`test/perceptronChecks.test.ts`) with no canvas, no React and no Zustand.
 */
export interface PerceptronMeasurements {
  /** The dataset currently loaded -- a task pinned to `blobs` cannot pass while on XOR. */
  dataset: string;
  accuracy: number;
  /** Epochs run on the *current* dataset. */
  epochsRun: number;
}

export function taskPasses(task: PerceptronTask, measurements: PerceptronMeasurements): boolean {
  const { check } = task;
  if (check.dataset !== measurements.dataset) return false;
  if (check.accuracy !== undefined && !meetsExactly(check.accuracy, measurements.accuracy)) {
    return false;
  }
  if (
    check.epochsRun !== undefined &&
    !satisfiesComparison(check.epochsRun, measurements.epochsRun)
  ) {
    return false;
  }
  return true;
}

/** The ids passing *right now*. Stickiness is the progress store's job, not this function's. */
export function evaluatePerceptronTasks(
  config: PerceptronConfig,
  measurements: PerceptronMeasurements,
): string[] {
  return config.tasks.filter((task) => taskPasses(task, measurements)).map((task) => task.id);
}
