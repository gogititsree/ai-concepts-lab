import {
  ExerciseDetailSchema,
  LessonDetailSchema,
  ModuleDetailSchema,
  ModuleListResponseSchema,
  QuizDetailSchema,
  type ExerciseState,
  type ModuleExercise,
  type ModuleLesson,
  type ProgressStatus,
  type QuizQuestionPublic,
} from '@lab/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  exercises,
  lessons,
  modules,
  quizQuestions,
  quizzes,
  userExerciseProgress,
  userLessonProgress,
} from '../db/schema.js';
import { authContext } from '../auth/guards.js';
import { notFound } from '../lib/errors.js';
import { parseCompletionRule } from '../progress/grading.js';
import {
  loadBestAttempt,
  loadCountsByModule,
  loadProgressByModule,
  listPublishedModules,
  toModuleSummary,
  toPassThreshold,
} from './repository.js';

/**
 * `/api/v1` content reads: modules, lessons, exercises, quizzes.
 *
 * Everything here is scoped to the caller — a module listing carries *their* progress —
 * so the whole group sits behind `requireFullSession` (registered in `app.ts`). There is
 * no anonymous read path: the roadmap's "module gating UX" is "all modules open, progress
 * shown", and progress needs a user.
 *
 * **The rule this file exists to enforce** (docs/02-schema.md → quiz_questions):
 * `GET /quizzes/:id` never serialises `correct` or `explanation_md`. It is enforced twice,
 * on purpose:
 *   1. the SELECT lists the columns it wants, so the answers are never read out of
 *      Postgres in the first place, and
 *   2. the response Zod schema has no field to put them in, so even a future handler that
 *      spread a full row could not emit them.
 * The integration test asserts on the raw serialised body, not on the object.
 */

const SlugParamsSchema = z.object({ slug: z.string().min(1).max(64) });
const IdParamsSchema = z.object({ id: z.string().uuid() });

/** jsonb columns come back as `unknown`; the contract says "an object". */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asState(value: unknown): ExerciseState | null {
  if (value === null || value === undefined) return null;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ExerciseState)
    : null;
}

const NOT_STARTED: ProgressStatus = 'not_started';

export const contentRoutes: FastifyPluginAsync = async (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------------------------- modules ----

  routes.get(
    '/modules',
    { schema: { response: { 200: ModuleListResponseSchema } } },
    async (request) => {
      const { user } = authContext(request);
      const userId = user.id;
      const [moduleRows, counts, progress] = await Promise.all([
        listPublishedModules(app.db),
        loadCountsByModule(app.db),
        loadProgressByModule(app.db, userId),
      ]);

      return {
        modules: moduleRows.map((module) =>
          toModuleSummary(module, counts.get(module.id), progress.get(module.id)),
        ),
      };
    },
  );

  // ------------------------------------------------------------ module detail ----

  routes.get(
    '/modules/:slug',
    { schema: { params: SlugParamsSchema, response: { 200: ModuleDetailSchema } } },
    async (request) => {
      const { user } = authContext(request);
      const userId = user.id;
      const { slug } = request.params;

      const [module] = await app.db
        .select()
        .from(modules)
        .where(and(eq(modules.slug, slug), eq(modules.isPublished, true)))
        .limit(1);
      if (!module) throw notFound(`Module "${slug}" not found`);

      // Four small queries rather than one wide join: a module has a handful of lessons
      // and one quiz, and the join would multiply rows by (lessons x exercises x
      // questions) only to be de-duplicated in JS.
      const [lessonRows, exerciseRows, quizRow, counts, progress] = await Promise.all([
        app.db
          .select({
            id: lessons.id,
            slug: lessons.slug,
            title: lessons.title,
            orderIndex: lessons.orderIndex,
            estimatedMinutes: lessons.estimatedMinutes,
            status: userLessonProgress.status,
          })
          .from(lessons)
          .leftJoin(
            userLessonProgress,
            and(eq(userLessonProgress.lessonId, lessons.id), eq(userLessonProgress.userId, userId)),
          )
          .where(eq(lessons.moduleId, module.id))
          .orderBy(asc(lessons.orderIndex)),
        app.db
          .select({
            id: exercises.id,
            slug: exercises.slug,
            title: exercises.title,
            kind: exercises.kind,
            orderIndex: exercises.orderIndex,
            config: exercises.config,
            completionRule: exercises.completionRule,
            status: userExerciseProgress.status,
            tasksCompleted: userExerciseProgress.tasksCompleted,
            state: userExerciseProgress.state,
          })
          .from(exercises)
          .leftJoin(
            userExerciseProgress,
            and(
              eq(userExerciseProgress.exerciseId, exercises.id),
              eq(userExerciseProgress.userId, userId),
            ),
          )
          .where(eq(exercises.moduleId, module.id))
          .orderBy(asc(exercises.orderIndex)),
        app.db.select().from(quizzes).where(eq(quizzes.moduleId, module.id)).limit(1),
        loadCountsByModule(app.db),
        loadProgressByModule(app.db, userId),
      ]);

      const moduleCounts = counts.get(module.id);
      const quiz = quizRow[0];

      const lessonList: ModuleLesson[] = lessonRows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        orderIndex: row.orderIndex,
        estimatedMinutes: row.estimatedMinutes,
        status: row.status ?? NOT_STARTED,
      }));

      const exerciseList: ModuleExercise[] = exerciseRows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        orderIndex: row.orderIndex,
        config: asRecord(row.config),
        completionRule: parseCompletionRule(row.completionRule),
        status: row.status ?? NOT_STARTED,
        tasksCompleted: row.tasksCompleted ?? [],
        state: asState(row.state),
      }));

      return {
        module: toModuleSummary(module, moduleCounts, progress.get(module.id)),
        lessons: lessonList,
        exercises: exerciseList,
        quiz: quiz
          ? {
              id: quiz.id,
              title: quiz.title,
              passThreshold: toPassThreshold(quiz.passThreshold),
              questionCount: moduleCounts?.quizQuestions ?? 0,
              bestAttempt: await loadBestAttempt(app.db, userId, quiz.id),
            }
          : null,
      };
    },
  );

  // -------------------------------------------------------------------- lesson ----

  routes.get(
    '/lessons/:id',
    { schema: { params: IdParamsSchema, response: { 200: LessonDetailSchema } } },
    async (request) => {
      const { user } = authContext(request);
      const userId = user.id;
      const [row] = await app.db
        .select({
          id: lessons.id,
          moduleId: lessons.moduleId,
          moduleSlug: modules.slug,
          moduleTitle: modules.title,
          slug: lessons.slug,
          title: lessons.title,
          orderIndex: lessons.orderIndex,
          estimatedMinutes: lessons.estimatedMinutes,
          bodyMd: lessons.bodyMd,
          status: userLessonProgress.status,
        })
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .leftJoin(
          userLessonProgress,
          and(eq(userLessonProgress.lessonId, lessons.id), eq(userLessonProgress.userId, userId)),
        )
        .where(and(eq(lessons.id, request.params.id), eq(modules.isPublished, true)))
        .limit(1);

      if (!row) throw notFound('Lesson not found');
      return { ...row, status: row.status ?? NOT_STARTED };
    },
  );

  // ------------------------------------------------------------------ exercise ----

  routes.get(
    '/exercises/:id',
    { schema: { params: IdParamsSchema, response: { 200: ExerciseDetailSchema } } },
    async (request) => {
      const { user } = authContext(request);
      const userId = user.id;
      const [row] = await app.db
        .select({
          id: exercises.id,
          moduleId: exercises.moduleId,
          moduleSlug: modules.slug,
          moduleTitle: modules.title,
          slug: exercises.slug,
          title: exercises.title,
          kind: exercises.kind,
          orderIndex: exercises.orderIndex,
          config: exercises.config,
          completionRule: exercises.completionRule,
          status: userExerciseProgress.status,
          tasksCompleted: userExerciseProgress.tasksCompleted,
          state: userExerciseProgress.state,
        })
        .from(exercises)
        .innerJoin(modules, eq(modules.id, exercises.moduleId))
        .leftJoin(
          userExerciseProgress,
          and(
            eq(userExerciseProgress.exerciseId, exercises.id),
            eq(userExerciseProgress.userId, userId),
          ),
        )
        .where(and(eq(exercises.id, request.params.id), eq(modules.isPublished, true)))
        .limit(1);

      if (!row) throw notFound('Exercise not found');
      return {
        ...row,
        config: asRecord(row.config),
        completionRule: parseCompletionRule(row.completionRule),
        status: row.status ?? NOT_STARTED,
        tasksCompleted: row.tasksCompleted ?? [],
        state: asState(row.state),
      };
    },
  );

  // ---------------------------------------------------------------------- quiz ----

  routes.get(
    '/quizzes/:id',
    { schema: { params: IdParamsSchema, response: { 200: QuizDetailSchema } } },
    async (request) => {
      const { user } = authContext(request);
      const userId = user.id;
      const [quiz] = await app.db
        .select({
          id: quizzes.id,
          moduleId: quizzes.moduleId,
          moduleSlug: modules.slug,
          moduleTitle: modules.title,
          title: quizzes.title,
          passThreshold: quizzes.passThreshold,
        })
        .from(quizzes)
        .innerJoin(modules, eq(modules.id, quizzes.moduleId))
        .where(and(eq(quizzes.id, request.params.id), eq(modules.isPublished, true)))
        .limit(1);

      if (!quiz) throw notFound('Quiz not found');

      // Explicit column list. `correct` and `explanationMd` are not selected, so the
      // answers never leave Postgres for this request — `select()` with no argument, or
      // a spread of a full row, is the bug this shape prevents.
      const questionRows = await app.db
        .select({
          id: quizQuestions.id,
          orderIndex: quizQuestions.orderIndex,
          kind: quizQuestions.kind,
          promptMd: quizQuestions.promptMd,
          options: quizQuestions.options,
          points: quizQuestions.points,
        })
        .from(quizQuestions)
        .where(eq(quizQuestions.quizId, quiz.id))
        .orderBy(asc(quizQuestions.orderIndex));

      const questions: QuizQuestionPublic[] = questionRows.map((row) => ({
        id: row.id,
        orderIndex: row.orderIndex,
        kind: row.kind,
        promptMd: row.promptMd,
        options: Array.isArray(row.options)
          ? (row.options as { id: string; textMd: string }[])
          : null,
        points: row.points,
      }));

      return {
        id: quiz.id,
        moduleId: quiz.moduleId,
        moduleSlug: quiz.moduleSlug,
        moduleTitle: quiz.moduleTitle,
        title: quiz.title,
        passThreshold: toPassThreshold(quiz.passThreshold),
        questions,
        bestAttempt: await loadBestAttempt(app.db, userId, quiz.id),
      };
    },
  );
};
