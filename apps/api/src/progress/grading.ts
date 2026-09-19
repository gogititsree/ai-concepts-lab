import {
  ChoiceCorrectSchema,
  CompletionRuleSchema,
  EXERCISE_STATE_MAX_BYTES,
  NumericCorrectSchema,
  ShortTextCorrectSchema,
  type CompletionRule,
  type GradedQuestion,
  type ProgressStatus,
  type QuestionKind,
  type QuizAnswer,
  type QuizCorrect,
} from '@lab/shared';

/**
 * Every rule the progress API applies, with no database anywhere in the file.
 *
 * That constraint is the point: quiz grading and completion-rule evaluation are the only
 * places in this app where the server overrules the client, so they are the places that
 * most need tests that run in milliseconds and cover the boundaries (a numeric answer
 * exactly on the tolerance, a multi-select that is a subset, a 64 KB state). The routes
 * next door are then thin: load rows, call these, write rows.
 */

// --------------------------------------------------------------- quiz grading ----

export interface GradableQuestion {
  id: string;
  orderIndex: number;
  kind: QuestionKind;
  /** The `quiz_questions.correct` jsonb exactly as stored. */
  correct: unknown;
  explanationMd: string;
  points: number;
}

export interface AttemptGrade {
  questions: GradedQuestion[];
  scorePoints: number;
  maxPoints: number;
  fraction: number;
  passed: boolean;
}

/** Thrown when a stored `correct` does not match its question kind — a seed bug, not a user one. */
export class MalformedQuestionError extends Error {
  constructor(
    readonly questionId: string,
    detail: string,
  ) {
    super(`question ${questionId}: ${detail}`);
    this.name = 'MalformedQuestionError';
  }
}

/**
 * Parses `correct` with the schema its `kind` demands. The seed already validated it, so a
 * failure here means the row was edited by hand or the content schema changed under it.
 */
export function parseCorrect(question: GradableQuestion): QuizCorrect {
  const schema =
    question.kind === 'numeric'
      ? NumericCorrectSchema
      : question.kind === 'short_text'
        ? ShortTextCorrectSchema
        : ChoiceCorrectSchema;
  const parsed = schema.safeParse(question.correct);
  if (!parsed.success) {
    throw new MalformedQuestionError(
      question.id,
      `stored "correct" does not match kind "${question.kind}"`,
    );
  }
  return parsed.data;
}

/** `lower_trim` is the only normalisation the content schema offers; `none` is verbatim. */
export function normaliseText(text: string, mode: 'lower_trim' | 'none'): string {
  return mode === 'none' ? text : text.trim().toLowerCase();
}

/**
 * Float64 slack for the numeric comparison, scaled to the magnitude of the numbers.
 *
 * Without it the tolerance is a lie at its own boundary: `0.705 - 0.7` evaluates to
 * 0.005000000000000004, so a learner who typed the value exactly one tolerance away from
 * the answer would be marked wrong by 4e-18. A few ulps of slack fixes that and is far
 * too small to let a genuinely wrong answer through (the tightest tolerance in the
 * curriculum is 0.001, twelve orders of magnitude larger).
 */
function floatSlack(a: number, b: number): number {
  return Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 4;
}

function sameIdSet(given: readonly string[], expected: readonly string[]): boolean {
  const a = new Set(given);
  const b = new Set(expected);
  if (a.size !== b.size) return false;
  for (const id of b) if (!a.has(id)) return false;
  return true;
}

/**
 * One question, one answer, one verdict — no partial credit inside a question.
 *
 * The four kinds, and the decision each one embodies:
 *  - `single_choice`  exact match (set equality over a one-element set, so selecting the
 *                     right answer *and* a wrong one is wrong).
 *  - `multi_choice`   set equality: "select all that apply" means all, and only.
 *  - `numeric`        |given − expected| ≤ tolerance, inclusive. A tolerance of 0 is an
 *                     exact match, which is what the integer questions in the curriculum
 *                     want.
 *  - `short_text`     normalised equality against any of the acceptable strings.
 *
 * An unanswered question (or one answered in the wrong shape, e.g. text for a numeric) is
 * wrong rather than an error: the attempt is graded as submitted.
 */
export function isAnswerCorrect(
  question: GradableQuestion,
  answer: QuizAnswer | undefined,
): boolean {
  if (answer === undefined) return false;
  const correct = parseCorrect(question);

  if (question.kind === 'single_choice' || question.kind === 'multi_choice') {
    if (!('optionIds' in answer) || !('optionIds' in correct)) return false;
    return sameIdSet(answer.optionIds, correct.optionIds);
  }

  if (question.kind === 'numeric') {
    if (!('value' in answer) || answer.value === null) return false;
    if (!('value' in correct)) return false;
    if (!Number.isFinite(answer.value)) return false;
    return (
      Math.abs(answer.value - correct.value) <=
      correct.tolerance + floatSlack(answer.value, correct.value)
    );
  }

  // short_text
  if (!('text' in answer) || !('acceptable' in correct)) return false;
  const given = normaliseText(answer.text, correct.normalize);
  return correct.acceptable.some((option) => normaliseText(option, correct.normalize) === given);
}

/**
 * Grades a whole attempt. `answers` is keyed by question id rather than positional so a
 * client that reorders or omits questions cannot shift every answer by one.
 */
export function gradeAttempt(
  questions: readonly GradableQuestion[],
  answers: ReadonlyMap<string, QuizAnswer>,
  passThreshold: number,
): AttemptGrade {
  const graded: GradedQuestion[] = questions.map((question) => {
    const answer = answers.get(question.id);
    const isCorrect = isAnswerCorrect(question, answer);
    return {
      questionId: question.id,
      orderIndex: question.orderIndex,
      isCorrect,
      pointsAwarded: isCorrect ? question.points : 0,
      points: question.points,
      answer: answer ?? null,
      correct: parseCorrect(question),
      explanationMd: question.explanationMd,
    };
  });

  const scorePoints = graded.reduce((sum, q) => sum + q.pointsAwarded, 0);
  const maxPoints = graded.reduce((sum, q) => sum + q.points, 0);
  const fraction = maxPoints === 0 ? 0 : scorePoints / maxPoints;

  return {
    questions: graded,
    scorePoints,
    maxPoints,
    fraction,
    // The epsilon guards the "exactly the threshold" case: `pass_threshold` is
    // numeric(3,2) parsed from a string and `fraction` is a division, and two routes to
    // the same decimal need not land on the same double. 1e-9 is far below any score a
    // quiz of a dozen questions can produce and far above the rounding error.
    passed: fraction + 1e-9 >= passThreshold,
  };
}

// ----------------------------------------------------------- completion rules ----

/** Parses `exercises.completion_rule` jsonb; an unreadable rule degrades to `manual`. */
export function parseCompletionRule(value: unknown): CompletionRule {
  const parsed = CompletionRuleSchema.safeParse(value);
  return parsed.success ? parsed.data : { type: 'manual' };
}

/**
 * The union of task ids ever reported. `tasks_completed` only ever grows: a learner who
 * reached 100 % and then dragged a point back over the line has still done the task.
 * Sorted so the stored array is stable and two equal sets compare equal.
 */
export function mergeTaskIds(
  previous: readonly string[],
  incoming: readonly string[] | undefined,
): string[] {
  return [...new Set([...previous, ...(incoming ?? [])])].sort();
}

/**
 * The server's decision about whether an exercise is done.
 *
 * Under a `{type:'tasks'}` rule the client's `status` is ignored entirely — the count of
 * recorded task ids decides, which is what stops `PUT {status:'completed'}` from being a
 * completion. Under `{type:'manual'}` there is nothing to count, so the client's proposal
 * is accepted (and "completed" is sticky: a later save of `state` does not un-complete it).
 */
export function resolveExerciseStatus(
  rule: CompletionRule,
  tasksCompleted: readonly string[],
  proposed: ProgressStatus | undefined,
  previous: ProgressStatus | undefined,
): ProgressStatus {
  if (rule.type === 'tasks') {
    if (tasksCompleted.length >= rule.required) return 'completed';
    if (previous === 'completed') return 'completed';
    if (tasksCompleted.length > 0) return 'in_progress';
    // No tasks yet: the client may still say "I opened this", but never "I finished it".
    if (proposed === 'in_progress') return 'in_progress';
    return previous ?? 'not_started';
  }

  if (previous === 'completed') return 'completed';
  return proposed ?? previous ?? 'in_progress';
}

// ------------------------------------------------------------- the state limit ----

export { EXERCISE_STATE_MAX_BYTES };

/**
 * Size of the state as Postgres will store it. `Buffer.byteLength` rather than
 * `String.length`: the limit is bytes, and a lesson reflection in any non-Latin script
 * would otherwise be measured at half its real size.
 */
export function stateByteLength(state: unknown): number {
  return Buffer.byteLength(JSON.stringify(state ?? null), 'utf8');
}

export function exceedsStateLimit(state: unknown): boolean {
  return stateByteLength(state) > EXERCISE_STATE_MAX_BYTES;
}
