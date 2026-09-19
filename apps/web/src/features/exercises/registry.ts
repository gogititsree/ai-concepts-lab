import type { ExerciseFileEntry, ExerciseKind } from '@lab/shared';
import type { ComponentType } from 'react';

import type { StaticModule } from '../../content/static';
import { MlpExercise } from './mlp/MlpExercise';
import { PerceptronExercise } from './perceptron/PerceptronExercise';

/**
 * `exercise.kind` -> the component that plays it.
 *
 * A registry rather than a switch in the route, because every later milestone adds a kind
 * (M8 `tokenizer`, M9 `prompt`, M10 `agent`, M11 `harness`) and this is the only line each of
 * them has to touch. Kinds with no entry are not an error -- the route says "coming in a later
 * milestone", which is true and more useful than a crash.
 */

export interface ExerciseComponentProps {
  module: StaticModule;
  exercise: ExerciseFileEntry;
}

export const EXERCISE_REGISTRY: Partial<
  Record<ExerciseKind, ComponentType<ExerciseComponentProps>>
> = {
  perceptron: PerceptronExercise,
  mlp: MlpExercise,
};
