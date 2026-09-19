import type { ModuleCounts, ModuleProgress, ModuleSummary } from '@lab/shared';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  exercises,
  lessons,
  modules,
  quizAttempts,
  quizQuestions,
  quizzes,
  vUserModuleProgress,
} from '../db/schema.js';

/**
 * The read side of the content API: the queries shared by `content/routes.ts` and
 * `progress/routes.ts`, so the two never disagree about what "module progress" means.
 */

export type ModuleRow = typeof modules.$inferSelect;

/**
 * Per-module progress straight from `v_user_module_progress`, **with the view's NULLs
 * already gone**.
 *
 * The view aggregates with `bool_or(...)` over a LEFT JOIN, and `bool_or` over zero rows
 * is SQL NULL, not `false`. So a module the learner has never opened comes back as
 * `exercise_done = NULL`, `quiz_passed = NULL`, `module_completed = NULL`. Coalescing is
 * done here in SQL rather than in each caller for two reasons: it cannot be forgotten by
 * a new route, and the database is where the NULL is generated, so that is where the
 * decision that "no rows means not done" belongs.
 *
 * (`lessons_total`/`lessons_done` are `count(...)`, which is 0 over zero rows, so they
 * need nothing. The asymmetry between `count` and `bool_or` is exactly the trap.)
 */
export async function loadProgressByModule(
  db: Db,
  userId: string,
): Promise<Map<string, Omit<ModuleProgress, 'fraction'>>> {
  const rows = await db
    .select({
      moduleId: vUserModuleProgress.moduleId,
      lessonsTotal: vUserModuleProgress.lessonsTotal,
      lessonsDone: vUserModuleProgress.lessonsDone,
      exerciseDone: sql<boolean>`coalesce(${vUserModuleProgress.exerciseDone}, false)`,
      quizPassed: sql<boolean>`coalesce(${vUserModuleProgress.quizPassed}, false)`,
      moduleCompleted: sql<boolean>`coalesce(${vUserModuleProgress.moduleCompleted}, false)`,
    })
    .from(vUserModuleProgress)
    .where(eq(vUserModuleProgress.userId, userId));

  return new Map(
    rows.map((row) => [
      row.moduleId,
      {
        lessonsTotal: Number(row.lessonsTotal),
        lessonsDone: Number(row.lessonsDone),
        // A second net under the SQL coalesce: the response schema forbids null, and a
        // serialisation error would be a 500 on a page that only wanted to draw a ring.
        exerciseDone: row.exerciseDone ?? false,
        quizPassed: row.quizPassed ?? false,
        moduleCompleted: row.moduleCompleted ?? false,
      },
    ]),
  );
}

/**
 * How far through a module the learner is, as one number for the ring.
 *
 * Every lesson counts once, the exercise counts once and the quiz counts once — the same
 * weighting the M3 localStorage version used, so the rings do not jump when progress
 * moves to the server.
 */
export function progressFraction(
  progress: Omit<ModuleProgress, 'fraction'>,
  counts: ModuleCounts,
): number {
  const parts =
    progress.lessonsTotal + (counts.exercises > 0 ? 1 : 0) + (counts.quizQuestions > 0 ? 1 : 0);
  if (parts === 0) return 0;
  const done =
    progress.lessonsDone + (progress.exerciseDone ? 1 : 0) + (progress.quizPassed ? 1 : 0);
  return Math.min(1, done / parts);
}

const EMPTY_PROGRESS: Omit<ModuleProgress, 'fraction'> = {
  lessonsTotal: 0,
  lessonsDone: 0,
  exerciseDone: false,
  quizPassed: false,
  moduleCompleted: false,
};

/** Counts of the things inside each module, keyed by module id. */
export async function loadCountsByModule(db: Db): Promise<Map<string, ModuleCounts>> {
  const [lessonCounts, exerciseCounts, questionCounts] = await Promise.all([
    db.select({ moduleId: lessons.moduleId, n: count() }).from(lessons).groupBy(lessons.moduleId),
    db
      .select({ moduleId: exercises.moduleId, n: count() })
      .from(exercises)
      .groupBy(exercises.moduleId),
    db
      .select({ moduleId: quizzes.moduleId, n: count(quizQuestions.id) })
      .from(quizzes)
      .leftJoin(quizQuestions, eq(quizQuestions.quizId, quizzes.id))
      .groupBy(quizzes.moduleId),
  ]);

  const counts = new Map<string, ModuleCounts>();
  const at = (moduleId: string): ModuleCounts => {
    const existing = counts.get(moduleId);
    if (existing) return existing;
    const fresh: ModuleCounts = { lessons: 0, exercises: 0, quizQuestions: 0 };
    counts.set(moduleId, fresh);
    return fresh;
  };
  for (const row of lessonCounts) at(row.moduleId).lessons = Number(row.n);
  for (const row of exerciseCounts) at(row.moduleId).exercises = Number(row.n);
  for (const row of questionCounts) at(row.moduleId).quizQuestions = Number(row.n);
  return counts;
}

export function toModuleSummary(
  module: ModuleRow,
  counts: ModuleCounts | undefined,
  progress: Omit<ModuleProgress, 'fraction'> | undefined,
): ModuleSummary {
  const resolvedCounts: ModuleCounts = counts ?? { lessons: 0, exercises: 0, quizQuestions: 0 };
  // A user row for every module comes from the view's CROSS JOIN, but a module created
  // between the two queries would have none; zeros are the honest answer.
  const resolvedProgress = progress ?? { ...EMPTY_PROGRESS, lessonsTotal: resolvedCounts.lessons };
  return {
    id: module.id,
    slug: module.slug,
    title: module.title,
    summary: module.summary,
    orderIndex: module.orderIndex,
    requiresModel: module.requiresModel,
    counts: resolvedCounts,
    progress: {
      ...resolvedProgress,
      fraction: progressFraction(resolvedProgress, resolvedCounts),
    },
  };
}

/** Published modules in reading order. Unpublished ones are invisible to the API entirely. */
export async function listPublishedModules(db: Db): Promise<ModuleRow[]> {
  return db
    .select()
    .from(modules)
    .where(eq(modules.isPublished, true))
    .orderBy(asc(modules.orderIndex));
}

export interface BestAttempt {
  id: string;
  scorePoints: number;
  maxPoints: number;
  fraction: number;
  passed: boolean;
  submittedAt: string;
}

export function toAttemptSummary(row: typeof quizAttempts.$inferSelect): BestAttempt {
  return {
    id: row.id,
    scorePoints: row.scorePoints,
    maxPoints: row.maxPoints,
    fraction: row.maxPoints === 0 ? 0 : row.scorePoints / row.maxPoints,
    passed: row.passed,
    submittedAt: row.submittedAt.toISOString(),
  };
}

/**
 * The learner's best attempt at a quiz, by score. Ties break towards the older attempt,
 * which is the one that proved the knowledge first.
 */
export async function loadBestAttempt(
  db: Db,
  userId: string,
  quizId: string,
): Promise<BestAttempt | null> {
  const [row] = await db
    .select()
    .from(quizAttempts)
    .where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId)))
    .orderBy(desc(quizAttempts.scorePoints), asc(quizAttempts.submittedAt))
    .limit(1);
  return row ? toAttemptSummary(row) : null;
}

/** `numeric(3,2)` arrives from the driver as a string; the wire contract is a number. */
export const toPassThreshold = (value: string): number => Number(value);
