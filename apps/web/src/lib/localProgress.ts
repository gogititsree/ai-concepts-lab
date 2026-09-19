/**
 * TODO(M7): replace with API. Progress belongs in Postgres behind `PUT /progress/...`; until
 * auth (M5) and the progress API (M7) exist there is nowhere to put it but this browser.
 *
 * The shape is deliberately the shape the API will return -- `user_lesson_progress`,
 * `user_exercise_progress` and the best `quiz_attempt` from docs/02-schema.md -- so M7 is a
 * swap of the storage layer and not a rewrite of every component that reads it. The only
 * difference is the key: slugs now, uuids then.
 *
 * Every localStorage access is wrapped: Safari in private mode throws on `setItem`, and a
 * learner with storage disabled should lose their tick marks, not the page.
 */

export type ProgressStatus = 'not_started' | 'in_progress' | 'completed';

export interface LessonProgress {
  status: ProgressStatus;
  completedAt: string | null;
}

export interface ExerciseProgress {
  status: ProgressStatus;
  tasksCompleted: string[];
  completedAt: string | null;
  /** `user_exercise_progress.state` in M7: the learner's saved work for this exercise. */
  state?: Record<string, unknown>;
}

export interface QuizAttemptSummary {
  scorePoints: number;
  maxPoints: number;
  passed: boolean;
  submittedAt: string;
}

export interface ProgressSnapshot {
  /** Keyed `${moduleSlug}/${lessonSlug}`. */
  lessons: Record<string, LessonProgress>;
  /** Keyed `${moduleSlug}/${exerciseSlug}`. */
  exercises: Record<string, ExerciseProgress>;
  /** Keyed by module slug; the best attempt, as `GET /progress` will report it. */
  quizzes: Record<string, QuizAttemptSummary>;
}

const STORAGE_KEY = 'ai-concepts-lab.progress.v1';

const EMPTY: ProgressSnapshot = { lessons: {}, exercises: {}, quizzes: {} };

export const lessonKey = (moduleSlug: string, lessonSlug: string): string =>
  `${moduleSlug}/${lessonSlug}`;
export const exerciseKey = (moduleSlug: string, exerciseSlug: string): string =>
  `${moduleSlug}/${exerciseSlug}`;

let cache: ProgressSnapshot | null = null;
const listeners = new Set<() => void>();

function read(): ProgressSnapshot {
  if (cache) return cache;
  cache = EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProgressSnapshot>;
      cache = {
        lessons: parsed.lessons ?? {},
        exercises: parsed.exercises ?? {},
        quizzes: parsed.quizzes ?? {},
      };
    }
  } catch {
    // Corrupt or unavailable storage: start empty rather than break the page.
    cache = EMPTY;
  }
  return cache;
}

function write(next: ProgressSnapshot): void {
  // The cache updates even if persistence fails, so the session stays self-consistent.
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full, disabled or in private mode. Nothing useful to do about it.
  }
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` contract: stable identity until something actually changes. */
export function getSnapshot(): ProgressSnapshot {
  return read();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setLessonStatus(
  moduleSlug: string,
  lessonSlug: string,
  status: ProgressStatus,
): void {
  const current = read();
  write({
    ...current,
    lessons: {
      ...current.lessons,
      [lessonKey(moduleSlug, lessonSlug)]: {
        status,
        completedAt: status === 'completed' ? new Date().toISOString() : null,
      },
    },
  });
}

/**
 * Records the union of task ids that have ever passed their auto-check, and derives status
 * from `completionRule.required` exactly as the server will. Tasks are never un-completed: a
 * learner who reached 100 % and then dragged a point does not lose the tick.
 */
export function recordExerciseTasks(
  moduleSlug: string,
  exerciseSlug: string,
  taskIds: readonly string[],
  requiredForCompletion: number,
): ExerciseProgress {
  const current = read();
  const key = exerciseKey(moduleSlug, exerciseSlug);
  const previous = current.exercises[key];
  const merged = [...new Set([...(previous?.tasksCompleted ?? []), ...taskIds])].sort();

  const completed = merged.length >= requiredForCompletion;
  const next: ExerciseProgress = {
    ...previous,
    status: completed ? 'completed' : merged.length > 0 ? 'in_progress' : 'not_started',
    completedAt: completed ? (previous?.completedAt ?? new Date().toISOString()) : null,
    tasksCompleted: merged,
  };

  if (
    previous &&
    previous.status === next.status &&
    previous.tasksCompleted.join() === next.tasksCompleted.join()
  ) {
    return previous;
  }
  write({ ...current, exercises: { ...current.exercises, [key]: next } });
  return next;
}

/** Keeps the best attempt by score -- what `GET /progress` will return in M7. */
export function recordQuizAttempt(moduleSlug: string, attempt: QuizAttemptSummary): void {
  const current = read();
  const previous = current.quizzes[moduleSlug];
  if (previous && previous.scorePoints >= attempt.scorePoints) return;
  write({ ...current, quizzes: { ...current.quizzes, [moduleSlug]: attempt } });
}

/** Mirrors the `state` jsonb column: whatever the exercise wants to remember between visits. */
export function setExerciseState(
  moduleSlug: string,
  exerciseSlug: string,
  state: Record<string, unknown>,
): void {
  const current = read();
  const key = exerciseKey(moduleSlug, exerciseSlug);
  const previous = current.exercises[key] ?? {
    status: 'in_progress' as ProgressStatus,
    tasksCompleted: [],
    completedAt: null,
  };
  write({
    ...current,
    exercises: {
      ...current.exercises,
      [key]: { ...previous, state: { ...previous.state, ...state } },
    },
  });
}

export function resetProgress(): void {
  write({ lessons: {}, exercises: {}, quizzes: {} });
}

export interface ModuleProgressSummary {
  lessonsCompleted: number;
  lessonCount: number;
  exerciseStatus: ProgressStatus;
  quiz: QuizAttemptSummary | null;
  /** 0-1 across lessons + exercise + quiz, for the ring on the dashboard. */
  fraction: number;
}

export function summariseModule(
  snapshot: ProgressSnapshot,
  module: { slug: string; lessons: { slug: string }[]; exercises: { slug: string }[] },
): ModuleProgressSummary {
  const lessonsCompleted = module.lessons.filter(
    (lesson) => snapshot.lessons[lessonKey(module.slug, lesson.slug)]?.status === 'completed',
  ).length;
  const exercise = module.exercises[0];
  const exerciseStatus = exercise
    ? (snapshot.exercises[exerciseKey(module.slug, exercise.slug)]?.status ?? 'not_started')
    : 'not_started';
  const quiz = snapshot.quizzes[module.slug] ?? null;

  const parts = module.lessons.length + (exercise ? 1 : 0) + 1;
  const done = lessonsCompleted + (exerciseStatus === 'completed' ? 1 : 0) + (quiz?.passed ? 1 : 0);

  return {
    lessonsCompleted,
    lessonCount: module.lessons.length,
    exerciseStatus,
    quiz,
    fraction: parts === 0 ? 0 : done / parts,
  };
}
