import type { QuestionKind, QuizAnswer, QuizCorrect, QuizOption } from '@lab/shared';

/**
 * **The answer key is gone.** Until M7 this file graded quizzes in the browser against
 * `correct` values that shipped in the bundle. `POST /quizzes/:id/attempts` now grades
 * server-side and `GET /quizzes/:id` does not serialise `correct` or `explanationMd` at
 * all (docs/02-schema.md makes that a tested rule), so there is nothing left to grade
 * with and nothing left to read out of devtools.
 *
 * What remains is presentation: turning the graded result the API *does* return into
 * something a human reads. Pure functions, no state, no answers.
 */

/** `0.875` -> `"88 %"`. One place, so the ring, the score and the threshold agree. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

/**
 * The correct answer as a sentence, for the results view.
 *
 * The API returns `correct` in the same shape family it is stored in
 * (`{optionIds}` / `{value, tolerance}` / `{acceptable, normalize}`), which is right for
 * a wire format and unreadable on a page: option ids mean nothing without the options.
 */
export function describeCorrect(
  kind: QuestionKind,
  correct: QuizCorrect,
  options: QuizOption[] | null,
): string {
  if (kind === 'numeric' && 'value' in correct) {
    return correct.tolerance > 0 ? `${correct.value} (± ${correct.tolerance})` : `${correct.value}`;
  }
  if (kind === 'short_text' && 'acceptable' in correct) {
    return correct.acceptable.join(' / ');
  }
  if ('optionIds' in correct) {
    const labelFor = (id: string): string =>
      options?.find((option) => option.id === id)?.textMd ?? id;
    return correct.optionIds.map(labelFor).join(' + ');
  }
  return '';
}

/** Whether the learner has put anything in this question yet — for the "n answered" count. */
export function isAnswered(answer: QuizAnswer | undefined): boolean {
  if (!answer) return false;
  if ('optionIds' in answer) return answer.optionIds.length > 0;
  if ('value' in answer) return answer.value !== null;
  return answer.text.trim().length > 0;
}

/** The option ids currently selected, for a controlled checkbox/radio group. */
export function selectedOptionIds(answer: QuizAnswer | undefined): string[] {
  return answer && 'optionIds' in answer ? answer.optionIds : [];
}
