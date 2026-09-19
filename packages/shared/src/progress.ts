import { z } from 'zod';

import { CompletionRuleSchema, ExerciseKindSchema, QuestionKindSchema } from './content.js';

/**
 * Wire contracts for the content and progress API (M7):
 *
 *   GET    /modules                    -> ModuleListResponse
 *   GET    /modules/:slug              -> ModuleDetail
 *   GET    /lessons/:id                -> LessonDetail
 *   GET    /exercises/:id              -> ExerciseDetail
 *   GET    /quizzes/:id                -> QuizDetail          (no answers, ever)
 *   PUT    /progress/lessons/:id       -> LessonProgress
 *   PUT    /progress/exercises/:id     -> ExerciseProgress
 *   GET    /progress                   -> ProgressSummary
 *   POST   /quizzes/:id/attempts       -> QuizAttemptResult   (answers *and* explanations)
 *   GET    /quizzes/:id/attempts       -> QuizAttemptHistory
 *
 * `content.ts` next door describes the *authored files*; this file describes what the API
 * hands the browser. They are deliberately separate: the file format may grow a field the
 * API does not serialise (and `quiz_questions.correct` is exactly that field).
 *
 * Fastify serialises every response through these schemas, so a field that is not named
 * here cannot reach a client even if a handler puts it in the object. That structural
 * guarantee is the second half of the "never leak `correct`" rule from docs/02-schema.md;
 * the first half is the route selecting columns explicitly.
 */

// ------------------------------------------------------------------ primitives ----

/** Matches the `progress_status` Postgres enum. */
export const ProgressStatusSchema = z.enum(['not_started', 'in_progress', 'completed']);
export type ProgressStatus = z.infer<typeof ProgressStatusSchema>;

const UuidSchema = z.string().uuid();
const IsoTimestampSchema = z.string().datetime();

/**
 * `user_exercise_progress.state` is jsonb with a 64 KB ceiling (docs/02-schema.md). The
 * limit is enforced on the *serialised* bytes, because that is what Postgres stores and
 * what a malicious client can inflate cheaply with a deeply nested object.
 */
export const EXERCISE_STATE_MAX_BYTES = 64 * 1024;

/** The learner's saved work: an object, because the exercises all key their state by name. */
export const ExerciseStateSchema = z.record(z.unknown());
export type ExerciseState = z.infer<typeof ExerciseStateSchema>;

// -------------------------------------------------------------- module summary ----

/**
 * Per-module rollup as `v_user_module_progress` computes it, with one difference that is
 * the whole reason this schema is strict about nullability: the view's `bool_or` over
 * zero rows is SQL NULL, so an untouched module reports `exercise_done = NULL`. The API
 * coalesces to `false` before serialising — "no rows" and "not done" mean the same thing
 * to a progress ring, and a nullable boolean in the client is three states of nothing.
 */
export const ModuleProgressSchema = z.object({
  lessonsTotal: z.number().int().nonnegative(),
  lessonsDone: z.number().int().nonnegative(),
  exerciseDone: z.boolean(),
  quizPassed: z.boolean(),
  moduleCompleted: z.boolean(),
  /** 0–1 over lessons + exercise + quiz; what the dashboard ring draws. */
  fraction: z.number().min(0).max(1),
});
export type ModuleProgress = z.infer<typeof ModuleProgressSchema>;

export const ModuleCountsSchema = z.object({
  lessons: z.number().int().nonnegative(),
  exercises: z.number().int().nonnegative(),
  quizQuestions: z.number().int().nonnegative(),
});
export type ModuleCounts = z.infer<typeof ModuleCountsSchema>;

export const ModuleSummarySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  orderIndex: z.number().int(),
  requiresModel: z.boolean(),
  counts: ModuleCountsSchema,
  progress: ModuleProgressSchema,
});
export type ModuleSummary = z.infer<typeof ModuleSummarySchema>;

export const ModuleListResponseSchema = z.object({ modules: z.array(ModuleSummarySchema) });
export type ModuleListResponse = z.infer<typeof ModuleListResponseSchema>;

// --------------------------------------------------------------- module detail ----

export const ModuleLessonSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  title: z.string(),
  orderIndex: z.number().int(),
  estimatedMinutes: z.number().int(),
  status: ProgressStatusSchema,
});
export type ModuleLesson = z.infer<typeof ModuleLessonSchema>;

export const ModuleExerciseSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  title: z.string(),
  kind: ExerciseKindSchema,
  orderIndex: z.number().int(),
  config: z.record(z.unknown()),
  completionRule: CompletionRuleSchema,
  status: ProgressStatusSchema,
  /** Only ever grows; the union of every task id that has passed its auto-check. */
  tasksCompleted: z.array(z.string()),
  state: ExerciseStateSchema.nullable(),
});
export type ModuleExercise = z.infer<typeof ModuleExerciseSchema>;

/** The learner's own view of an attempt: no per-question detail, no answers. */
export const QuizAttemptSummarySchema = z.object({
  id: UuidSchema,
  scorePoints: z.number().int().nonnegative(),
  maxPoints: z.number().int().nonnegative(),
  fraction: z.number().min(0).max(1),
  passed: z.boolean(),
  submittedAt: IsoTimestampSchema,
});
export type QuizAttemptSummary = z.infer<typeof QuizAttemptSummarySchema>;

export const QuizSummarySchema = z.object({
  id: UuidSchema,
  title: z.string(),
  passThreshold: z.number().min(0).max(1),
  questionCount: z.number().int().nonnegative(),
  /** The best attempt by score, or null when the quiz has never been submitted. */
  bestAttempt: QuizAttemptSummarySchema.nullable(),
});
export type QuizSummary = z.infer<typeof QuizSummarySchema>;

export const ModuleDetailSchema = z.object({
  module: ModuleSummarySchema,
  lessons: z.array(ModuleLessonSchema),
  exercises: z.array(ModuleExerciseSchema),
  /** Nullable because the schema allows a module without a quiz; the curriculum has none. */
  quiz: QuizSummarySchema.nullable(),
});
export type ModuleDetail = z.infer<typeof ModuleDetailSchema>;

// --------------------------------------------------------------- lesson detail ----

export const LessonDetailSchema = z.object({
  id: UuidSchema,
  moduleId: UuidSchema,
  moduleSlug: z.string(),
  moduleTitle: z.string(),
  slug: z.string(),
  title: z.string(),
  orderIndex: z.number().int(),
  estimatedMinutes: z.number().int(),
  bodyMd: z.string(),
  status: ProgressStatusSchema,
});
export type LessonDetail = z.infer<typeof LessonDetailSchema>;

// ------------------------------------------------------------- exercise detail ----

export const ExerciseDetailSchema = z.object({
  id: UuidSchema,
  moduleId: UuidSchema,
  moduleSlug: z.string(),
  moduleTitle: z.string(),
  slug: z.string(),
  title: z.string(),
  kind: ExerciseKindSchema,
  orderIndex: z.number().int(),
  config: z.record(z.unknown()),
  completionRule: CompletionRuleSchema,
  status: ProgressStatusSchema,
  tasksCompleted: z.array(z.string()),
  state: ExerciseStateSchema.nullable(),
});
export type ExerciseDetail = z.infer<typeof ExerciseDetailSchema>;

// ----------------------------------------------------------------- quiz detail ----

export const QuizQuestionPublicSchema = z.object({
  id: UuidSchema,
  orderIndex: z.number().int(),
  kind: QuestionKindSchema,
  promptMd: z.string(),
  /** `[{id, textMd}]` for the choice kinds, null otherwise. */
  options: z.array(z.object({ id: z.string(), textMd: z.string() })).nullable(),
  points: z.number().int().positive(),
});
export type QuizQuestionPublic = z.infer<typeof QuizQuestionPublicSchema>;

/**
 * Note what this object does *not* have: `correct` and `explanationMd`. Adding either
 * here would be the bug the leak test in `test/integration/content.test.ts` catches.
 */
export const QuizDetailSchema = z.object({
  id: UuidSchema,
  moduleId: UuidSchema,
  moduleSlug: z.string(),
  moduleTitle: z.string(),
  title: z.string(),
  passThreshold: z.number().min(0).max(1),
  questions: z.array(QuizQuestionPublicSchema),
  bestAttempt: QuizAttemptSummarySchema.nullable(),
});
export type QuizDetail = z.infer<typeof QuizDetailSchema>;

// -------------------------------------------------------------- quiz answering ----

/**
 * One answer, in the same shape family as `quiz_questions.correct` (docs/02-schema.md):
 * `{optionIds}` for the choice kinds, `{value}` for numeric, `{text}` for short text.
 *
 * A union rather than a tagged object because the stored `answer` jsonb and the stored
 * `correct` jsonb then read the same way in psql, which matters the day someone is
 * debugging a "why was this marked wrong" question by hand.
 */
export const QuizAnswerSchema = z.union([
  z.object({ optionIds: z.array(z.string().min(1)) }).strict(),
  z.object({ value: z.number().nullable() }).strict(),
  z.object({ text: z.string() }).strict(),
]);
export type QuizAnswer = z.infer<typeof QuizAnswerSchema>;

export const QuizAttemptRequestSchema = z.object({
  answers: z
    .array(z.object({ questionId: UuidSchema, answer: QuizAnswerSchema }).strict())
    .max(200),
});
export type QuizAttemptRequest = z.infer<typeof QuizAttemptRequestSchema>;

/** The `correct` shapes, as returned *after* grading. */
export const QuizCorrectSchema = z.union([
  z.object({ optionIds: z.array(z.string()) }),
  z.object({ value: z.number(), tolerance: z.number() }),
  z.object({ acceptable: z.array(z.string()), normalize: z.enum(['lower_trim', 'none']) }),
]);
export type QuizCorrect = z.infer<typeof QuizCorrectSchema>;

export const GradedQuestionSchema = z.object({
  questionId: UuidSchema,
  orderIndex: z.number().int(),
  isCorrect: z.boolean(),
  pointsAwarded: z.number().int().nonnegative(),
  points: z.number().int().positive(),
  /** Echoed back so the results view can render what was submitted. */
  answer: QuizAnswerSchema.nullable(),
  /** Released only here — never by `GET /quizzes/:id`. */
  correct: QuizCorrectSchema,
  explanationMd: z.string(),
});
export type GradedQuestion = z.infer<typeof GradedQuestionSchema>;

export const QuizAttemptResultSchema = z.object({
  attemptId: UuidSchema,
  quizId: UuidSchema,
  submittedAt: IsoTimestampSchema,
  scorePoints: z.number().int().nonnegative(),
  maxPoints: z.number().int().nonnegative(),
  fraction: z.number().min(0).max(1),
  passThreshold: z.number().min(0).max(1),
  passed: z.boolean(),
  questions: z.array(GradedQuestionSchema),
});
export type QuizAttemptResult = z.infer<typeof QuizAttemptResultSchema>;

export const QuizAttemptHistorySchema = z.object({
  attempts: z.array(QuizAttemptSummarySchema),
});
export type QuizAttemptHistory = z.infer<typeof QuizAttemptHistorySchema>;

// ------------------------------------------------------------ progress updates ----

export const LessonProgressUpdateSchema = z.object({ status: ProgressStatusSchema }).strict();
export type LessonProgressUpdate = z.infer<typeof LessonProgressUpdateSchema>;

export const LessonProgressSchema = z.object({
  lessonId: UuidSchema,
  status: ProgressStatusSchema,
  completedAt: IsoTimestampSchema.nullable(),
  updatedAt: IsoTimestampSchema,
});
export type LessonProgress = z.infer<typeof LessonProgressSchema>;

/**
 * Every field is optional and `status` is only a *proposal*: when the exercise has a
 * `{type:'tasks'}` completion rule the server derives the status from the task ids it has
 * recorded, so posting `status:'completed'` with no tasks does nothing. That asymmetry is
 * the point of evaluating `completion_rule` server-side (docs/02-schema.md → exercises).
 */
export const ExerciseProgressUpdateSchema = z
  .object({
    status: ProgressStatusSchema.optional(),
    state: ExerciseStateSchema.optional(),
    /** Task ids that passed their auto-check; merged with what is already stored. */
    tasksCompleted: z.array(z.string().min(1).max(64)).max(100).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.status !== undefined || body.state !== undefined || body.tasksCompleted !== undefined,
    'at least one of status, state or tasksCompleted is required',
  );
export type ExerciseProgressUpdate = z.infer<typeof ExerciseProgressUpdateSchema>;

export const ExerciseProgressSchema = z.object({
  exerciseId: UuidSchema,
  status: ProgressStatusSchema,
  state: ExerciseStateSchema.nullable(),
  tasksCompleted: z.array(z.string()),
  completedAt: IsoTimestampSchema.nullable(),
  updatedAt: IsoTimestampSchema,
});
export type ExerciseProgress = z.infer<typeof ExerciseProgressSchema>;

// ------------------------------------------------------------ progress summary ----

export const ModuleProgressEntrySchema = z.object({
  moduleId: UuidSchema,
  moduleSlug: z.string(),
  moduleTitle: z.string(),
  orderIndex: z.number().int(),
  progress: ModuleProgressSchema,
});
export type ModuleProgressEntry = z.infer<typeof ModuleProgressEntrySchema>;

export const ProgressSummarySchema = z.object({
  modules: z.array(ModuleProgressEntrySchema),
  /** Slug of the first module that is not finished — "continue where you left off". */
  nextModuleSlug: z.string().nullable(),
});
export type ProgressSummary = z.infer<typeof ProgressSummarySchema>;
