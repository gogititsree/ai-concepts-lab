import type { ExerciseDetail, ExerciseKind } from '@lab/shared';
import type { ComponentType } from 'react';

import { MlpExercise } from './mlp/MlpExercise';
import { PerceptronExercise } from './perceptron/PerceptronExercise';

/**
 * `exercise.kind` -> the component that plays it.
 *
 * A registry rather than a switch in the route, because every later milestone adds a kind
 * (M8 `tokenizer`, M9 `prompt`, M10 `agent`, M11 `harness`) and this is the only line each of
 * them has to touch. Kinds with no entry are not an error -- the route says "coming in a later
 * milestone", which is true and more useful than a crash.
 *
 * M7 changed the prop from a bundled content object to the API's `ExerciseDetail`, which
 * carries the id every save needs and the learner's `state` to resume from.
 */

export interface ExerciseComponentProps {
  exercise: ExerciseDetail;
}

export const EXERCISE_REGISTRY: Partial<
  Record<ExerciseKind, ComponentType<ExerciseComponentProps>>
> = {
  perceptron: PerceptronExercise,
  mlp: MlpExercise,
};
