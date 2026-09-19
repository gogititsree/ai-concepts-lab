import type { ExerciseConfigSchemas } from '@lab/shared';
import type { z } from 'zod';

import { satisfiesComparison } from '../checkRules';

export type MlpConfig = z.infer<(typeof ExerciseConfigSchemas)['mlp']>;
export type MlpTask = MlpConfig['tasks'][number];

export interface MlpMeasurements {
  dataset: string;
  loss: number;
  accuracy: number;
  epochs: number;
  singleSteps: number;
  hiddenSize: number;
}

/**
 * `maxEpochs` is a budget, not a target: "loss below 0.05 **within** 2000 epochs" fails once
 * the budget is spent, which is what makes a learning rate of 10 an interesting way to fail.
 */
export function taskPasses(task: MlpTask, m: MlpMeasurements): boolean {
  const { check } = task;
  if (check.dataset !== undefined && check.dataset !== m.dataset) return false;
  if (check.maxEpochs !== undefined && m.epochs > check.maxEpochs) return false;
  if (check.loss !== undefined && !satisfiesComparison(check.loss, m.loss)) return false;
  if (check.accuracy !== undefined && !satisfiesComparison(check.accuracy, m.accuracy))
    return false;
  if (check.singleSteps !== undefined && !satisfiesComparison(check.singleSteps, m.singleSteps)) {
    return false;
  }
  return true;
}

export function evaluateMlpTasks(config: MlpConfig, m: MlpMeasurements): string[] {
  return config.tasks.filter((task) => taskPasses(task, m)).map((task) => task.id);
}

/**
 * The answer a `record` task is asking for, when it is passing right now.
 *
 * `circle-hidden-size` wants the *smallest* hidden size above 95 %, so the caller keeps the
 * minimum across attempts (in the exercise's saved state); this function only reports what the
 * current configuration proves.
 */
export function recordedValue(task: MlpTask, m: MlpMeasurements): number | undefined {
  if (task.check.record !== 'hiddenSize') return undefined;
  return taskPasses(task, m) ? m.hiddenSize : undefined;
}

/** Keeps the smaller of the two, treating "nothing recorded yet" as no constraint. */
export function bestRecord(
  previous: number | undefined,
  candidate: number | undefined,
): number | undefined {
  if (candidate === undefined) return previous;
  if (previous === undefined) return candidate;
  return Math.min(previous, candidate);
}
