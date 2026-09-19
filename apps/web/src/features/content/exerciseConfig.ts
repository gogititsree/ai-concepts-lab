import { ExerciseConfigSchemas, type ExerciseKind } from '@lab/shared';
import type { z } from 'zod';

/**
 * Re-parses an exercise's `config` through the per-kind Zod schema so a feature gets a
 * typed config instead of `Record<string, unknown>`.
 *
 * The seed validated it before it ever reached the database and the API serialises it
 * back out unchanged, so this is not a second opinion — it is the cast made honest, and
 * it is the one place a content change that the UI cannot handle surfaces as an error
 * with a path rather than as an empty canvas.
 *
 * (This function lived in `src/content/static.ts` until M7 deleted it along with the
 * bundled curriculum. It is the only part of that file that outlived the API.)
 */
export function parseExerciseConfig<K extends ExerciseKind>(
  kind: K,
  config: Record<string, unknown>,
): z.infer<(typeof ExerciseConfigSchemas)[K]> {
  return ExerciseConfigSchemas[kind].parse(config) as z.infer<(typeof ExerciseConfigSchemas)[K]>;
}
