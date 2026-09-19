import type { ExerciseDetail, ExerciseKind } from '@lab/shared';
import type { ComponentType } from 'react';

import { AgentExercise } from './agent/AgentExercise';
import { HarnessExercise } from './harness/HarnessExercise';
import { MlpExercise } from './mlp/MlpExercise';
import { PerceptronExercise } from './perceptron/PerceptronExercise';
import { PromptExercise } from './prompt/PromptExercise';
import { TokenizerExercise } from './tokenizer/TokenizerExercise';

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
  // M8: Module 3 ships one record of kind `tokenizer` carrying all three tabs, so this
  // single entry covers tokenization, embeddings and attention. The `embeddings` and
  // `attention` kinds have config schemas of their own but no content uses them alone.
  tokenizer: TokenizerExercise,
  // M9. `structured_output` is a sub-mode of the same component rather than a separate
  // exercise row, so it maps to the same entry.
  prompt: PromptExercise,
  structured_output: PromptExercise,
  // M10. The loop runs on the server; this component is the controls plus the streaming
  // trace.
  agent: AgentExercise,
  // M11. The same trace viewer, fed by a loop the learner wrote, running in a Web Worker
  // in their own browser. The server only opens the run and accepts the steps.
  harness: HarnessExercise,
};
