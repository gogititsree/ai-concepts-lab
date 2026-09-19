import type { QuizFile, QuizQuestionFile } from '@lab/shared';

/**
 * TODO(M7): replace with API. `POST /quizzes/:id/attempts` grades server-side, and
 * `GET /quizzes/:id` stops serialising `correct` and `explanation_md` at all (docs/02-schema.md
 * makes that a tested rule). Until then the answers are in the bundle and a curious learner can
 * read them out of devtools -- which, for a solo learning app with no score that matters, is an
 * acceptable trade for shipping Modules 1 and 2 before the database exists.
 *
 * The grading itself is pure and exported so the same rules can be tested question kind by
 * question kind, and so M7 can diff this implementation against the server's.
 */

export type QuizAnswer =
  | { kind: 'choice'; optionIds: string[] }
  | { kind: 'numeric'; value: number | null }
  | { kind: 'text'; text: string };

export interface GradedQuestion {
  index: number;
  isCorrect: boolean;
  pointsAwarded: number;
  points: number;
}

export interface GradedQuiz {
  perQuestion: GradedQuestion[];
  scorePoints: number;
  maxPoints: number;
  fraction: number;
  passed: boolean;
}

function sameIdSet(selected: readonly string[], expected: readonly string[]): boolean {
  const a = new Set(selected);
  const b = new Set(expected);
  if (a.size !== b.size) return false;
  for (const id of b) if (!a.has(id)) return false;
  return true;
}

function normalise(text: string, mode: 'lower_trim' | 'none'): string {
  return mode === 'none' ? text : text.trim().toLowerCase();
}

/**
 * One question, one answer, one verdict. An unanswered question is wrong rather than skipped:
 * partial credit inside a question is not a thing this course models.
 */
export function gradeQuestion(question: QuizQuestionFile, answer: QuizAnswer | undefined): boolean {
  const correct = question.correct;

  if (question.kind === 'single_choice' || question.kind === 'multi_choice') {
    if (!answer || answer.kind !== 'choice' || !('optionIds' in correct)) return false;
    return sameIdSet(answer.optionIds, correct.optionIds);
  }

  if (question.kind === 'numeric') {
    if (!answer || answer.kind !== 'numeric' || answer.value === null) return false;
    if (!('value' in correct)) return false;
    if (!Number.isFinite(answer.value)) return false;
    return Math.abs(answer.value - correct.value) <= correct.tolerance;
  }

  if (!answer || answer.kind !== 'text' || !('acceptable' in correct)) return false;
  const given = normalise(answer.text, correct.normalize);
  return correct.acceptable.some((option) => normalise(option, correct.normalize) === given);
}

export function gradeQuiz(
  quiz: QuizFile,
  answers: readonly (QuizAnswer | undefined)[],
): GradedQuiz {
  const perQuestion = quiz.questions.map((question, index) => {
    const isCorrect = gradeQuestion(question, answers[index]);
    return {
      index,
      isCorrect,
      pointsAwarded: isCorrect ? question.points : 0,
      points: question.points,
    };
  });

  const scorePoints = perQuestion.reduce((sum, q) => sum + q.pointsAwarded, 0);
  const maxPoints = perQuestion.reduce((sum, q) => sum + q.points, 0);
  const fraction = maxPoints === 0 ? 0 : scorePoints / maxPoints;

  return {
    perQuestion,
    scorePoints,
    maxPoints,
    fraction,
    // `>=` with a tiny epsilon: 7/10 is 0.6999999999999999 in float64, and a learner who
    // answered exactly the threshold must pass.
    passed: fraction + 1e-9 >= quiz.passThreshold,
  };
}
