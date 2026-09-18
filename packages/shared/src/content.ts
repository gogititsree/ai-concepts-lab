import { z } from 'zod';

/**
 * Contracts for the authored curriculum files under `content/modules/<order>-<slug>/`:
 *
 *   module.json      -> ModuleFileSchema
 *   lessons/NN-x.md  -> LessonFrontmatterSchema (YAML-ish frontmatter) + Markdown body
 *   exercises.json   -> ExercisesFileSchema
 *   quiz.json        -> QuizFileSchema
 *
 * The seed script (`apps/api/src/db/seed.ts`) validates every file against these before
 * a single row is written, so a typo in content fails at seed time with a file path
 * rather than at runtime with a React crash.
 *
 * Everything is `.strict()`: an unknown key is almost always a typo in a hand-authored
 * file, and silently ignoring it is how content and schema drift apart.
 */

/** Matches the `exercise_kind` Postgres enum in docs/02-schema.md. */
export const ExerciseKindSchema = z.enum([
  'perceptron',
  'mlp',
  'tokenizer',
  'embeddings',
  'attention',
  'prompt',
  'structured_output',
  'agent',
  'harness',
]);
export type ExerciseKind = z.infer<typeof ExerciseKindSchema>;

/** Matches the `question_kind` Postgres enum. */
export const QuestionKindSchema = z.enum([
  'single_choice',
  'multi_choice',
  'numeric',
  'short_text',
]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');

// ------------------------------------------------------------------ module.json ----

export const ModuleFileSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1),
    /** One paragraph, shown on the module card. */
    summary: z.string().min(1),
    orderIndex: z.number().int().positive(),
    /** True for modules 4-6: the UI shows the "run locally" banner. */
    requiresModel: z.boolean().default(false),
    isPublished: z.boolean().default(true),
  })
  .strict();
export type ModuleFile = z.infer<typeof ModuleFileSchema>;

// ------------------------------------------------------------------- lessons/*.md ----

export const LessonFrontmatterSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1),
    orderIndex: z.number().int().positive(),
    estimatedMinutes: z.number().int().positive().max(240).default(10),
  })
  .strict();
export type LessonFrontmatter = z.infer<typeof LessonFrontmatterSchema>;

export interface ParsedLessonFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Deliberately *not* gray-matter: the frontmatter this project authors is a flat block of
 * `key: value` lines, so a real YAML parser would be ~200 KB of dependency to read four
 * scalars, and a hand-written parser keeps the failure modes obvious.
 *
 * Supported: a leading `---` fence, `key: value` pairs, `#` comments, blank lines,
 * optional single/double quotes around the value, and `true`/`false`/numbers/`null`
 * coerced to their JS types. Anything else (nested maps, lists, multi-line strings) is a
 * deliberate non-feature and will surface as a Zod error on the resulting object.
 */
export function parseFrontmatter(raw: string): ParsedLessonFile {
  // Normalise CRLF so Windows-authored files parse identically, and drop a leading
  // UTF-8 BOM -- charCodeAt rather than a regex literal, because a raw U+FEFF in source
  // is invisible and an escape is easy to mangle on a round-trip.
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const text = withoutBom.split('\r\n').join('\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) {
    throw new Error('missing frontmatter: file must start with a --- fenced block');
  }
  const [fence, block] = match;
  const frontmatter: Record<string, unknown> = {};

  for (const [i, line] of (block ?? '').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf(':');
    if (sep === -1) {
      throw new Error(`frontmatter line ${i + 1} is not "key: value": ${trimmed}`);
    }
    const key = trimmed.slice(0, sep).trim();
    const rawValue = trimmed.slice(sep + 1).trim();
    if (key === '') throw new Error(`frontmatter line ${i + 1} has an empty key`);
    frontmatter[key] = coerceScalar(rawValue);
  }

  return { frontmatter, body: text.slice(fence?.length ?? 0).trim() };
}

function coerceScalar(value: string): unknown {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

// ---------------------------------------------------------------- exercises.json ----

/**
 * How `PUT /progress/exercises/:id` decides an exercise is done. Interpreted server-side
 * (M7) so a learner cannot mark an exercise complete by posting `status: 'completed'`.
 */
export const CompletionRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tasks'), required: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('manual') }).strict(),
]);
export type CompletionRule = z.infer<typeof CompletionRuleSchema>;

/**
 * Per-kind config schemas. M4 only needs "it is an object": every exercise UI is written
 * in a later milestone (M3/M8-M11) and each one tightens its own entry here, which is why
 * this is a map rather than one big union — a milestone touches one key.
 */
const LooseConfigSchema = z.record(z.unknown());

export const ExerciseConfigSchemas: Record<ExerciseKind, z.ZodType<Record<string, unknown>>> = {
  perceptron: LooseConfigSchema,
  mlp: LooseConfigSchema,
  tokenizer: LooseConfigSchema,
  embeddings: LooseConfigSchema,
  attention: LooseConfigSchema,
  prompt: LooseConfigSchema,
  structured_output: LooseConfigSchema,
  agent: LooseConfigSchema,
  harness: LooseConfigSchema,
};

export const ExerciseFileEntrySchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1),
    kind: ExerciseKindSchema,
    orderIndex: z.number().int().positive(),
    /** Optional anchor: the lesson this exercise appears after, by slug. */
    lessonSlug: SlugSchema.optional(),
    config: LooseConfigSchema,
    completionRule: CompletionRuleSchema,
  })
  .strict()
  // Re-validate `config` through the per-kind schema so tightening a kind later is a
  // one-line change here and every existing content file is checked against it.
  .superRefine((exercise, ctx) => {
    const result = ExerciseConfigSchemas[exercise.kind].safeParse(exercise.config);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
      }
    }
  });
export type ExerciseFileEntry = z.infer<typeof ExerciseFileEntrySchema>;

export const ExercisesFileSchema = z.array(ExerciseFileEntrySchema).min(1);
export type ExercisesFile = z.infer<typeof ExercisesFileSchema>;

// --------------------------------------------------------------------- quiz.json ----

export const QuizOptionSchema = z
  .object({ id: z.string().min(1), textMd: z.string().min(1) })
  .strict();
export type QuizOption = z.infer<typeof QuizOptionSchema>;

/** The four `correct` shapes from docs/02-schema.md, one per question kind. */
export const ChoiceCorrectSchema = z
  .object({ optionIds: z.array(z.string().min(1)).min(1) })
  .strict();
export const NumericCorrectSchema = z
  .object({ value: z.number(), tolerance: z.number().nonnegative() })
  .strict();
export const ShortTextCorrectSchema = z
  .object({
    acceptable: z.array(z.string().min(1)).min(1),
    normalize: z.enum(['lower_trim', 'none']).default('lower_trim'),
  })
  .strict();

export const QuizQuestionSchema = z
  .object({
    kind: QuestionKindSchema,
    promptMd: z.string().min(1),
    options: z.array(QuizOptionSchema).min(2).optional(),
    /**
     * A union rather than `unknown` so the *shape* is checked (and `normalize` gets its
     * default) before the refinement below checks that the shape matches `kind`.
     */
    correct: z.union([ChoiceCorrectSchema, NumericCorrectSchema, ShortTextCorrectSchema]),
    explanationMd: z.string().min(1),
    points: z.number().int().positive().default(1),
  })
  .strict()
  /**
   * `correct` is typed per `kind`, and for the choice kinds every referenced option id
   * must actually exist. This refinement is the reason quiz authoring mistakes show up at
   * seed time instead of as a quiz nobody can pass.
   */
  .superRefine((question, ctx) => {
    const needsOptions = question.kind === 'single_choice' || question.kind === 'multi_choice';
    if (needsOptions && !question.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `options are required for kind "${question.kind}"`,
      });
    }
    if (!needsOptions && question.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `options are not allowed for kind "${question.kind}"`,
      });
    }

    const schema =
      question.kind === 'numeric'
        ? NumericCorrectSchema
        : question.kind === 'short_text'
          ? ShortTextCorrectSchema
          : ChoiceCorrectSchema;
    const parsed = schema.safeParse(question.correct);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ['correct', ...issue.path] });
      }
      return;
    }

    if (question.kind === 'single_choice') {
      const { optionIds } = parsed.data as z.infer<typeof ChoiceCorrectSchema>;
      if (optionIds.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correct', 'optionIds'],
          message: 'single_choice must have exactly one correct option id',
        });
      }
    }
    if (needsOptions) {
      const { optionIds } = parsed.data as z.infer<typeof ChoiceCorrectSchema>;
      const known = new Set((question.options ?? []).map((o) => o.id));
      for (const id of optionIds) {
        if (!known.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['correct', 'optionIds'],
            message: `unknown option id "${id}"`,
          });
        }
      }
    }
  });
export type QuizQuestionFile = z.infer<typeof QuizQuestionSchema>;

export const QuizFileSchema = z
  .object({
    title: z.string().min(1),
    /** Fraction correct required to pass; 0.7 across the course. */
    passThreshold: z.number().min(0).max(1).default(0.7),
    questions: z.array(QuizQuestionSchema).min(1),
  })
  .strict();
export type QuizFile = z.infer<typeof QuizFileSchema>;
