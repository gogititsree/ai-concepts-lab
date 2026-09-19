import {
  EXERCISE_STATE_MAX_BYTES,
  ExerciseProgressSchema,
  ExerciseProgressUpdateSchema,
  LessonProgressSchema,
  LessonProgressUpdateSchema,
  ProgressSummarySchema,
  QuizAttemptHistorySchema,
  QuizAttemptRequestSchema,
  QuizAttemptResultSchema,
  type ExerciseState,
  type ModuleProgressEntry,
  type QuizAnswer,
} from '@lab/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { authContext } from '../auth/guards.js';
import {
  listPublishedModules,
  loadCountsByModule,
  loadProgressByModule,
  progressFraction,
  toAttemptSummary,
  toPassThreshold,
} from '../content/repository.js';
import {
  exercises,
  lessons,
  modules,
  quizAttemptAnswers,
  quizAttempts,
  quizQuestions,
  quizzes,
  userExerciseProgress,
  userLessonProgress,
} from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import {
  exceedsStateLimit,
  gradeAttempt,
  mergeTaskIds,
  parseCompletionRule,
  resolveExerciseStatus,
  type GradableQuestion,
} from './grading.js';

/**
 * `/api/v1` progress writes and the quiz attempt flow.
 *
 * The theme of the file is that **the client proposes and the server decides**:
 *  - an exercise's status comes from `exercises.completion_rule` evaluated against the
 *    task ids the server has recorded, not from the `status` in the body;
 *  - a quiz is graded from `quiz_questions.correct`, which the client has never seen;
 *  - `state` is capped at 64 KB before it reaches Postgres.
 *
 * All of those rules live in `grading.ts`, which has no database import, so they are unit
 * tested in milliseconds; what is left here is loading rows, calling them, writing rows.
 */

const IdParamsSchema = z.object({ id: z.string().uuid() });

function asState(value: unknown): ExerciseState | null {
  if (value === null || value === undefined) return null;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ExerciseState)
    : null;
}

export const progressRoutes: FastifyPluginAsync = async (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------------- lesson progress ----

  routes.put(
    '/progress/lessons/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: LessonProgressUpdateSchema,
        response: { 200: LessonProgressSchema },
      },
    },
    async (request) => {
      const { user } = authContext(request);
      const lessonId = request.params.id;

      // The FK would reject an unknown lesson with a 500-shaped driver error; this turns
      // it into the 404 the contract promises, and scopes it to published modules.
      const [lesson] = await app.db
        .select({ id: lessons.id })
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .where(and(eq(lessons.id, lessonId), eq(modules.isPublished, true)))
        .limit(1);
      if (!lesson) throw notFound('Lesson not found');

      const { status } = request.body;
      const now = new Date();
      const completedAt = status === 'completed' ? now : null;

      const [row] = await app.db
        .insert(userLessonProgress)
        .values({ userId: user.id, lessonId, status, completedAt, updatedAt: now })
        .onConflictDoUpdate({
          target: [userLessonProgress.userId, userLessonProgress.lessonId],
          set: { status, completedAt, updatedAt: now },
        })
        .returning();
      if (!row) throw new Error('Upsert returned no row');

      return {
        lessonId: row.lessonId,
        status: row.status,
        completedAt: row.completedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );

  // ----------------------------------------------------- exercise progress ----

  routes.put(
    '/progress/exercises/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: ExerciseProgressUpdateSchema,
        response: { 200: ExerciseProgressSchema },
      },
    },
    async (request) => {
      const { user } = authContext(request);
      const exerciseId = request.params.id;
      const body = request.body;

      // Checked before any database work: rejecting a 5 MB body after a round trip is
      // just a slower rejection. 413 rather than 400 because the request is well-formed;
      // it is only too big (the error-handler maps 413 -> PAYLOAD_TOO_LARGE).
      if (body.state !== undefined && exceedsStateLimit(body.state)) {
        throw new AppError(
          413,
          'PAYLOAD_TOO_LARGE',
          `Exercise state must be at most ${EXERCISE_STATE_MAX_BYTES} bytes when serialised`,
        );
      }

      const [exercise] = await app.db
        .select({ id: exercises.id, completionRule: exercises.completionRule })
        .from(exercises)
        .innerJoin(modules, eq(modules.id, exercises.moduleId))
        .where(and(eq(exercises.id, exerciseId), eq(modules.isPublished, true)))
        .limit(1);
      if (!exercise) throw notFound('Exercise not found');

      const rule = parseCompletionRule(exercise.completionRule);

      // Read-then-write in one transaction: `tasks_completed` is a union with what is
      // already stored, so two debounced saves racing must not lose one of them.
      const row = await app.db.transaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(userExerciseProgress)
          .where(
            and(
              eq(userExerciseProgress.userId, user.id),
              eq(userExerciseProgress.exerciseId, exerciseId),
            ),
          )
          .limit(1);

        const tasksCompleted = mergeTaskIds(previous?.tasksCompleted ?? [], body.tasksCompleted);
        const status = resolveExerciseStatus(rule, tasksCompleted, body.status, previous?.status);
        const state = body.state === undefined ? (previous?.state ?? null) : body.state;
        const now = new Date();
        const completedAt = status === 'completed' ? (previous?.completedAt ?? now) : null;

        const [written] = await tx
          .insert(userExerciseProgress)
          .values({
            userId: user.id,
            exerciseId,
            status,
            state,
            tasksCompleted,
            completedAt,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [userExerciseProgress.userId, userExerciseProgress.exerciseId],
            set: { status, state, tasksCompleted, completedAt, updatedAt: now },
          })
          .returning();
        if (!written) throw new Error('Upsert returned no row');
        return written;
      });

      return {
        exerciseId: row.exerciseId,
        status: row.status,
        state: asState(row.state),
        tasksCompleted: row.tasksCompleted ?? [],
        completedAt: row.completedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );

  // ------------------------------------------------------ progress summary ----

  routes.get(
    '/progress',
    { schema: { response: { 200: ProgressSummarySchema } } },
    async (request) => {
      const { user } = authContext(request);
      const [moduleRows, counts, progress] = await Promise.all([
        listPublishedModules(app.db),
        loadCountsByModule(app.db),
        loadProgressByModule(app.db, user.id),
      ]);

      const entries: ModuleProgressEntry[] = moduleRows.map((module) => {
        const moduleCounts = counts.get(module.id) ?? {
          lessons: 0,
          exercises: 0,
          quizQuestions: 0,
        };
        // `loadProgressByModule` has already turned the view's `bool_or` NULLs into
        // `false`; the fallback here only covers a module with no view row at all.
        const raw = progress.get(module.id) ?? {
          lessonsTotal: moduleCounts.lessons,
          lessonsDone: 0,
          exerciseDone: false,
          quizPassed: false,
          moduleCompleted: false,
        };
        return {
          moduleId: module.id,
          moduleSlug: module.slug,
          moduleTitle: module.title,
          orderIndex: module.orderIndex,
          progress: { ...raw, fraction: progressFraction(raw, moduleCounts) },
        };
      });

      return {
        modules: entries,
        nextModuleSlug:
          entries.find((entry) => !entry.progress.moduleCompleted)?.moduleSlug ?? null,
      };
    },
  );

  // ---------------------------------------------------------- quiz attempts ----

  routes.post(
    '/quizzes/:id/attempts',
    {
      schema: {
        params: IdParamsSchema,
        body: QuizAttemptRequestSchema,
        response: { 201: QuizAttemptResultSchema },
      },
    },
    async (request, reply) => {
      const { user } = authContext(request);
      const quizId = request.params.id;

      const [quiz] = await app.db
        .select({ id: quizzes.id, passThreshold: quizzes.passThreshold })
        .from(quizzes)
        .innerJoin(modules, eq(modules.id, quizzes.moduleId))
        .where(and(eq(quizzes.id, quizId), eq(modules.isPublished, true)))
        .limit(1);
      if (!quiz) throw notFound('Quiz not found');

      // This is the one place `correct` and `explanation_md` are read.
      const questionRows = await app.db
        .select({
          id: quizQuestions.id,
          orderIndex: quizQuestions.orderIndex,
          kind: quizQuestions.kind,
          correct: quizQuestions.correct,
          explanationMd: quizQuestions.explanationMd,
          points: quizQuestions.points,
        })
        .from(quizQuestions)
        .where(eq(quizQuestions.quizId, quizId))
        .orderBy(asc(quizQuestions.orderIndex));

      const questions: GradableQuestion[] = questionRows;
      const known = new Set(questions.map((question) => question.id));

      const answers = new Map<string, QuizAnswer>();
      for (const entry of request.body.answers) {
        if (!known.has(entry.questionId)) {
          throw new AppError(
            400,
            'VALIDATION_FAILED',
            `Question ${entry.questionId} does not belong to this quiz`,
          );
        }
        answers.set(entry.questionId, entry.answer);
      }

      const passThreshold = toPassThreshold(quiz.passThreshold);
      const grade = gradeAttempt(questions, answers, passThreshold);

      // One transaction: an attempt whose answers failed to write would be a score with
      // nothing behind it, and `quiz_attempts.passed` is historical truth.
      const attempt = await app.db.transaction(async (tx) => {
        const now = new Date();
        const [created] = await tx
          .insert(quizAttempts)
          .values({
            userId: user.id,
            quizId,
            // No "start the quiz" call exists, so the attempt is a point in time. When
            // one is added, `started_at` becomes the row this route updates.
            startedAt: now,
            submittedAt: now,
            scorePoints: grade.scorePoints,
            maxPoints: grade.maxPoints,
            passed: grade.passed,
          })
          .returning();
        if (!created) throw new Error('Insert returned no attempt row');

        // Only answered questions get a row: `answer` is NOT NULL and there is no honest
        // jsonb for "they skipped it". An unanswered question is still graded (as wrong)
        // and still reported; it simply has nothing to store.
        const answerRows = grade.questions
          .filter((question) => question.answer !== null)
          .map((question) => ({
            attemptId: created.id,
            questionId: question.questionId,
            answer: question.answer,
            isCorrect: question.isCorrect,
            pointsAwarded: question.pointsAwarded,
          }));
        if (answerRows.length > 0) await tx.insert(quizAttemptAnswers).values(answerRows);

        return created;
      });

      return reply.code(201).send({
        attemptId: attempt.id,
        quizId,
        submittedAt: attempt.submittedAt.toISOString(),
        scorePoints: grade.scorePoints,
        maxPoints: grade.maxPoints,
        fraction: grade.fraction,
        passThreshold,
        passed: grade.passed,
        questions: grade.questions,
      });
    },
  );

  routes.get(
    '/quizzes/:id/attempts',
    { schema: { params: IdParamsSchema, response: { 200: QuizAttemptHistorySchema } } },
    async (request) => {
      const { user } = authContext(request);
      const quizId = request.params.id;

      const [quiz] = await app.db
        .select({ id: quizzes.id })
        .from(quizzes)
        .innerJoin(modules, eq(modules.id, quizzes.moduleId))
        .where(and(eq(quizzes.id, quizId), eq(modules.isPublished, true)))
        .limit(1);
      if (!quiz) throw notFound('Quiz not found');

      const rows = await app.db
        .select()
        .from(quizAttempts)
        .where(and(eq(quizAttempts.userId, user.id), eq(quizAttempts.quizId, quizId)))
        .orderBy(desc(quizAttempts.submittedAt))
        .limit(50);

      return { attempts: rows.map(toAttemptSummary) };
    },
  );
};
