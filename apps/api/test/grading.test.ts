import type { CompletionRule, QuizAnswer } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import {
  EXERCISE_STATE_MAX_BYTES,
  exceedsStateLimit,
  gradeAttempt,
  isAnswerCorrect,
  MalformedQuestionError,
  mergeTaskIds,
  normaliseText,
  parseCompletionRule,
  resolveExerciseStatus,
  stateByteLength,
  type GradableQuestion,
} from '../src/progress/grading.js';

/**
 * The rules the server refuses to let the client decide, tested where they are pure.
 *
 * Every case below is a boundary someone will eventually argue about: a numeric answer
 * exactly on the tolerance, a multi-select that is a superset, a `status:'completed'`
 * posted with no tasks, a state one byte over the limit.
 */

const question = (over: Partial<GradableQuestion>): GradableQuestion => ({
  id: '11111111-1111-4111-8111-111111111111',
  orderIndex: 1,
  kind: 'single_choice',
  correct: { optionIds: ['b'] },
  explanationMd: 'because',
  points: 1,
  ...over,
});

describe('isAnswerCorrect — single_choice', () => {
  const q = question({});

  it('accepts the one correct option', () => {
    expect(isAnswerCorrect(q, { optionIds: ['b'] })).toBe(true);
  });

  it('rejects the wrong option, no option, and no answer at all', () => {
    expect(isAnswerCorrect(q, { optionIds: ['a'] })).toBe(false);
    expect(isAnswerCorrect(q, { optionIds: [] })).toBe(false);
    expect(isAnswerCorrect(q, undefined)).toBe(false);
  });

  it('rejects the right option selected alongside a wrong one', () => {
    // Set equality, not membership: "b and also a" is not the answer to "pick one".
    expect(isAnswerCorrect(q, { optionIds: ['a', 'b'] })).toBe(false);
  });

  it('rejects an answer in the wrong shape for the kind', () => {
    expect(isAnswerCorrect(q, { text: 'b' })).toBe(false);
    expect(isAnswerCorrect(q, { value: 1 })).toBe(false);
  });
});

describe('isAnswerCorrect — multi_choice', () => {
  const q = question({ kind: 'multi_choice', correct: { optionIds: ['a', 'c'] }, points: 2 });

  it('requires the exact set, in any order', () => {
    expect(isAnswerCorrect(q, { optionIds: ['a', 'c'] })).toBe(true);
    expect(isAnswerCorrect(q, { optionIds: ['c', 'a'] })).toBe(true);
  });

  it('gives nothing for a partial selection (no partial credit inside a question)', () => {
    expect(isAnswerCorrect(q, { optionIds: ['a'] })).toBe(false);
    expect(isAnswerCorrect(q, { optionIds: ['c'] })).toBe(false);
  });

  it('rejects a superset', () => {
    expect(isAnswerCorrect(q, { optionIds: ['a', 'b', 'c'] })).toBe(false);
  });

  it('ignores duplicates in the submission', () => {
    expect(isAnswerCorrect(q, { optionIds: ['a', 'a', 'c'] })).toBe(true);
  });
});

describe('isAnswerCorrect — numeric', () => {
  const q = question({ kind: 'numeric', correct: { value: 0.7, tolerance: 0.005 } });

  it('accepts a value exactly on the tolerance, at both ends', () => {
    // `0.705 - 0.7` is 0.005000000000000004 in float64. A plain `<=` would mark the
    // boundary wrong by 4e-18, which is why `floatSlack` exists.
    expect(isAnswerCorrect(q, { value: 0.705 })).toBe(true);
    expect(isAnswerCorrect(q, { value: 0.695 })).toBe(true);
  });

  it('rejects just outside the tolerance', () => {
    expect(isAnswerCorrect(q, { value: 0.7051 })).toBe(false);
    expect(isAnswerCorrect(q, { value: 0.6949 })).toBe(false);
  });

  it('treats tolerance 0 as an exact match', () => {
    const exact = question({ kind: 'numeric', correct: { value: 17, tolerance: 0 } });
    expect(isAnswerCorrect(exact, { value: 17 })).toBe(true);
    expect(isAnswerCorrect(exact, { value: 17.000001 })).toBe(false);
  });

  it('handles negative expectations', () => {
    const negative = question({ kind: 'numeric', correct: { value: -0.032, tolerance: 0.005 } });
    expect(isAnswerCorrect(negative, { value: -0.03 })).toBe(true);
    expect(isAnswerCorrect(negative, { value: 0.032 })).toBe(false);
  });

  it('rejects null, NaN and Infinity', () => {
    expect(isAnswerCorrect(q, { value: null })).toBe(false);
    expect(isAnswerCorrect(q, { value: Number.NaN })).toBe(false);
    expect(isAnswerCorrect(q, { value: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('isAnswerCorrect — short_text', () => {
  const q = question({
    kind: 'short_text',
    correct: { acceptable: ['softmax', 'the softmax'], normalize: 'lower_trim' },
  });

  it('normalises case and surrounding whitespace', () => {
    expect(isAnswerCorrect(q, { text: '  SoftMax ' })).toBe(true);
    expect(isAnswerCorrect(q, { text: 'THE SOFTMAX' })).toBe(true);
  });

  it('does not normalise inside the string', () => {
    // `lower_trim` is trim + lowercase and nothing else; "soft max" is a different word.
    expect(isAnswerCorrect(q, { text: 'soft max' })).toBe(false);
  });

  it('is exact when normalize is none', () => {
    const verbatim = question({
      kind: 'short_text',
      correct: { acceptable: ['Softmax'], normalize: 'none' },
    });
    expect(isAnswerCorrect(verbatim, { text: 'Softmax' })).toBe(true);
    expect(isAnswerCorrect(verbatim, { text: 'softmax' })).toBe(false);
    expect(isAnswerCorrect(verbatim, { text: ' Softmax ' })).toBe(false);
  });

  it('rejects an empty answer', () => {
    expect(isAnswerCorrect(q, { text: '   ' })).toBe(false);
  });
});

describe('normaliseText', () => {
  it('trims and lowercases, or does nothing', () => {
    expect(normaliseText('  ReLU  ', 'lower_trim')).toBe('relu');
    expect(normaliseText('  ReLU  ', 'none')).toBe('  ReLU  ');
  });
});

describe('gradeAttempt', () => {
  const questions: GradableQuestion[] = [
    question({ id: '11111111-1111-4111-8111-111111111111', orderIndex: 1, points: 1 }),
    question({
      id: '22222222-2222-4222-8222-222222222222',
      orderIndex: 2,
      kind: 'multi_choice',
      correct: { optionIds: ['a', 'c'] },
      points: 2,
      explanationMd: 'two of them',
    }),
    question({
      id: '33333333-3333-4333-8333-333333333333',
      orderIndex: 3,
      kind: 'numeric',
      correct: { value: 3, tolerance: 0.001 },
      points: 1,
      explanationMd: 'three',
    }),
  ];

  const answers = (entries: [string, QuizAnswer][]) => new Map(entries);

  it('sums points, reports a fraction and returns every question', () => {
    const grade = gradeAttempt(
      questions,
      answers([
        [questions[0]!.id, { optionIds: ['b'] }],
        [questions[1]!.id, { optionIds: ['a'] }],
        [questions[2]!.id, { value: 3 }],
      ]),
      0.7,
    );

    expect(grade.scorePoints).toBe(2);
    expect(grade.maxPoints).toBe(4);
    expect(grade.fraction).toBe(0.5);
    expect(grade.passed).toBe(false);
    expect(grade.questions).toHaveLength(3);
    expect(grade.questions.map((q) => q.isCorrect)).toEqual([true, false, true]);
    expect(grade.questions[1]?.pointsAwarded).toBe(0);
  });

  it('returns the correct answer and the explanation for every question', () => {
    const grade = gradeAttempt(questions, answers([]), 0.7);
    expect(grade.questions[1]?.correct).toEqual({ optionIds: ['a', 'c'] });
    expect(grade.questions[1]?.explanationMd).toBe('two of them');
    // Unanswered is graded, not skipped.
    expect(grade.questions.every((q) => q.isCorrect === false)).toBe(true);
    expect(grade.questions.every((q) => q.answer === null)).toBe(true);
    expect(grade.scorePoints).toBe(0);
  });

  it('passes at exactly the threshold, and not just below it', () => {
    const ten: GradableQuestion[] = Array.from({ length: 10 }, (_, i) =>
      question({ id: `0000000${i}-0000-4000-8000-000000000000`, orderIndex: i + 1 }),
    );
    const rightAnswers = (n: number) =>
      answers(ten.slice(0, n).map((q) => [q.id, { optionIds: ['b'] }] as [string, QuizAnswer]));

    const exactly = gradeAttempt(ten, rightAnswers(7), 0.7);
    expect(exactly.scorePoints).toBe(7);
    expect(exactly.passed).toBe(true);

    // The pass epsilon is 1e-9: one mark short must still fail.
    expect(gradeAttempt(ten, rightAnswers(6), 0.7).passed).toBe(false);
  });

  it('keys answers by question id, so a reordered submission still grades correctly', () => {
    const grade = gradeAttempt(
      questions,
      answers([
        [questions[2]!.id, { value: 3 }],
        [questions[0]!.id, { optionIds: ['b'] }],
      ]),
      0.5,
    );
    expect(grade.questions[0]?.isCorrect).toBe(true);
    expect(grade.questions[2]?.isCorrect).toBe(true);
  });

  it('scores an empty quiz as 0/0 rather than dividing by zero', () => {
    const grade = gradeAttempt([], answers([]), 0.7);
    expect(grade.fraction).toBe(0);
    expect(grade.passed).toBe(false);
  });

  it('throws on a stored `correct` that does not match its kind', () => {
    const broken = question({ kind: 'numeric', correct: { optionIds: ['b'] } });
    expect(() => isAnswerCorrect(broken, { value: 1 })).toThrow(MalformedQuestionError);
  });
});

describe('completion rules', () => {
  const tasks: CompletionRule = { type: 'tasks', required: 2 };
  const manual: CompletionRule = { type: 'manual' };

  it('parses the two authored shapes and degrades an unreadable one to manual', () => {
    expect(parseCompletionRule({ type: 'tasks', required: 2 })).toEqual(tasks);
    expect(parseCompletionRule({ type: 'manual' })).toEqual(manual);
    expect(parseCompletionRule({ type: 'vibes' })).toEqual(manual);
    expect(parseCompletionRule(null)).toEqual(manual);
  });

  it('flips to completed at exactly the required number of tasks', () => {
    expect(resolveExerciseStatus(tasks, ['a'], undefined, undefined)).toBe('in_progress');
    expect(resolveExerciseStatus(tasks, ['a', 'b'], undefined, undefined)).toBe('completed');
    expect(resolveExerciseStatus(tasks, ['a', 'b', 'c'], undefined, undefined)).toBe('completed');
  });

  it('ignores a client claiming completion under a tasks rule', () => {
    expect(resolveExerciseStatus(tasks, [], 'completed', undefined)).toBe('not_started');
    expect(resolveExerciseStatus(tasks, ['a'], 'completed', undefined)).toBe('in_progress');
  });

  it('lets a client say "in progress" with no tasks yet', () => {
    expect(resolveExerciseStatus(tasks, [], 'in_progress', undefined)).toBe('in_progress');
  });

  it('never un-completes an exercise', () => {
    expect(resolveExerciseStatus(tasks, [], undefined, 'completed')).toBe('completed');
    expect(resolveExerciseStatus(manual, [], 'not_started', 'completed')).toBe('completed');
  });

  it('honours the client under a manual rule', () => {
    expect(resolveExerciseStatus(manual, [], 'completed', undefined)).toBe('completed');
    expect(resolveExerciseStatus(manual, [], undefined, undefined)).toBe('in_progress');
  });
});

describe('mergeTaskIds', () => {
  it('unions, de-duplicates and sorts', () => {
    expect(mergeTaskIds(['b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('never shrinks: a task that once passed stays passed', () => {
    expect(mergeTaskIds(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(mergeTaskIds(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });
});

describe('the 64 KB state limit', () => {
  it('measures bytes, not characters', () => {
    // "é" is two bytes in UTF-8; JSON.stringify keeps it as one character.
    expect(stateByteLength({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}', 'utf8'));
  });

  it('accepts a state exactly at the limit and rejects one byte more', () => {
    // {"s":"<padding>"} — the wrapper is 8 characters of ASCII.
    const wrapper = '{"s":""}'.length;
    const atLimit = { s: 'x'.repeat(EXERCISE_STATE_MAX_BYTES - wrapper) };
    expect(stateByteLength(atLimit)).toBe(EXERCISE_STATE_MAX_BYTES);
    expect(exceedsStateLimit(atLimit)).toBe(false);

    const overLimit = { s: 'x'.repeat(EXERCISE_STATE_MAX_BYTES - wrapper + 1) };
    expect(exceedsStateLimit(overLimit)).toBe(true);
  });

  it('accepts a realistic exercise state', () => {
    expect(
      exceedsStateLimit({ reflection: 'the line kept trading off two points', records: {} }),
    ).toBe(false);
  });
});
