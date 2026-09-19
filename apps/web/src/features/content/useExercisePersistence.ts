import type { ExerciseDetail, ExerciseState } from '@lab/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useSaveExerciseProgress } from './queries';

/**
 * Persistence for an exercise playground: the learner's saved work (`state`) and the
 * task ids that have passed their auto-check (`tasksCompleted`).
 *
 * The two are saved on deliberately different schedules, which is the whole reason this
 * is a hook and not a `useEffect` in each exercise:
 *
 *  - **`state` is debounced by 2 seconds** (docs/01-architecture.md → Persistence). It
 *    changes on every keystroke in the reflection box and on every measurement the MLP
 *    records; a request per keystroke would be absurd and the last write wins anyway.
 *  - **`tasksCompleted` is saved immediately.** Completing a task is the moment the
 *    learner is watching for, and it is the write that can flip the exercise to
 *    `completed` server-side. A two-second lag on a tick mark reads as a bug.
 *
 * A pending debounced save is flushed on unmount, so navigating away mid-sentence does
 * not lose the sentence.
 *
 * Note what the hook does *not* own: the status. The server derives it from
 * `completion_rule`, and the value it returns is what the exercise cache is refreshed
 * with — this hook never guesses.
 */

export const STATE_DEBOUNCE_MS = 2000;

export interface ExercisePersistence {
  /** The union of task ids that have ever passed, mirroring the server's text[]. */
  tasksCompleted: string[];
  /** The learner's saved work, seeded from the API and merged locally as it changes. */
  state: ExerciseState;
  /** Report the ids passing right now; saved immediately if that grows the union. */
  reportTasks: (ids: readonly string[]) => void;
  /** Merge a slice into the saved work; written 2 seconds after the last call. */
  patchState: (partial: ExerciseState) => void;
  isSaving: boolean;
  saveError: Error | null;
}

export function useExercisePersistence(
  exercise: ExerciseDetail,
  debounceMs: number = STATE_DEBOUNCE_MS,
): ExercisePersistence {
  const save = useSaveExerciseProgress();
  const { mutate } = save;
  const exerciseId = exercise.id;

  const [tasksCompleted, setTasksCompleted] = useState<string[]>(() =>
    [...exercise.tasksCompleted].sort(),
  );
  const [state, setState] = useState<ExerciseState>(() => ({ ...(exercise.state ?? {}) }));

  // The refs hold the authoritative values for the timer callbacks, which would
  // otherwise close over whatever the state was when they were scheduled.
  const tasksRef = useRef(tasksCompleted);
  const stateRef = useRef(state);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);

  const flushState = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!pendingRef.current) return;
    pendingRef.current = false;
    mutate({ exerciseId, state: stateRef.current });
  }, [exerciseId, mutate]);

  const patchState = useCallback(
    (partial: ExerciseState) => {
      const next = { ...stateRef.current, ...partial };
      // Cheap equality check: an exercise that recomputes the same measurement every
      // frame would otherwise keep the debounce timer permanently armed.
      if (JSON.stringify(next) === JSON.stringify(stateRef.current)) return;

      stateRef.current = next;
      setState(next);
      pendingRef.current = true;

      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flushState, debounceMs);
    },
    [debounceMs, flushState],
  );

  const reportTasks = useCallback(
    (ids: readonly string[]) => {
      const merged = [...new Set([...tasksRef.current, ...ids])].sort();
      if (merged.length === tasksRef.current.length) return;

      tasksRef.current = merged;
      setTasksCompleted(merged);
      // Immediate, and it carries any state edit that was still waiting, so the two
      // cannot be written out of order.
      pendingRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      mutate({ exerciseId, tasksCompleted: merged, state: stateRef.current });
    },
    [exerciseId, mutate],
  );

  // Flush on unmount. The effect body is empty on purpose: only the cleanup matters.
  useEffect(() => flushState, [flushState]);

  return {
    tasksCompleted,
    state,
    reportTasks,
    patchState,
    isSaving: save.isPending,
    saveError: save.error,
  };
}
