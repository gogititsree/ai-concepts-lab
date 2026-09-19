import type { QuizFile, QuizQuestionFile } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import { getModule } from '../src/content/static';
import { gradeQuestion, gradeQuiz } from '../src/lib/quizGrading';

const single: QuizQuestionFile = {
  kind: 'single_choice',
  promptMd: 'One answer',
  options: [
    { id: 'a', textMd: 'a' },
    { id: 'b', textMd: 'b' },
  ],
  correct: { optionIds: ['b'] },
  explanationMd: 'because',
  points: 1,
};

const multi: QuizQuestionFile = {
  kind: 'multi_choice',
  promptMd: 'Several answers',
  options: [
    { id: 'a', textMd: 'a' },
    { id: 'b', textMd: 'b' },
    { id: 'c', textMd: 'c' },
  ],
  correct: { optionIds: ['a', 'c'] },
  explanationMd: 'because',
  points: 2,
};

const numeric: QuizQuestionFile = {
  kind: 'numeric',
  promptMd: 'A number',
  correct: { value: -0.032, tolerance: 0.005 },
  explanationMd: 'because',
  points: 1,
};

const text: QuizQuestionFile = {
  kind: 'short_text',
  promptMd: 'A word',
  correct: { acceptable: ['Backpropagation'], normalize: 'lower_trim' },
  explanationMd: 'because',
  points: 1,
};

describe('gradeQuestion', () => {
  it('grades single_choice on the one selected id', () => {
    expect(gradeQuestion(single, { kind: 'choice', optionIds: ['b'] })).toBe(true);
    expect(gradeQuestion(single, { kind: 'choice', optionIds: ['a'] })).toBe(false);
    expect(gradeQuestion(single, { kind: 'choice', optionIds: ['a', 'b'] })).toBe(false);
  });

  it('grades multi_choice as set equality -- no partial credit', () => {
    expect(gradeQuestion(multi, { kind: 'choice', optionIds: ['a', 'c'] })).toBe(true);
    expect(gradeQuestion(multi, { kind: 'choice', optionIds: ['c', 'a'] })).toBe(true);
    expect(gradeQuestion(multi, { kind: 'choice', optionIds: ['a'] })).toBe(false);
    expect(gradeQuestion(multi, { kind: 'choice', optionIds: ['a', 'b', 'c'] })).toBe(false);
  });

  it('grades numeric inside the authored tolerance, sign included', () => {
    expect(gradeQuestion(numeric, { kind: 'numeric', value: -0.032 })).toBe(true);
    expect(gradeQuestion(numeric, { kind: 'numeric', value: -0.03 })).toBe(true);
    expect(gradeQuestion(numeric, { kind: 'numeric', value: 0.032 })).toBe(false);
    expect(gradeQuestion(numeric, { kind: 'numeric', value: -0.04 })).toBe(false);
    expect(gradeQuestion(numeric, { kind: 'numeric', value: null })).toBe(false);
  });

  it('grades short_text after normalisation', () => {
    expect(gradeQuestion(text, { kind: 'text', text: '  backpropagation ' })).toBe(true);
    expect(gradeQuestion(text, { kind: 'text', text: 'chain rule' })).toBe(false);
  });

  it('counts an unanswered question as wrong, whatever its kind', () => {
    for (const question of [single, multi, numeric, text]) {
      expect(gradeQuestion(question, undefined)).toBe(false);
    }
  });

  it('refuses an answer of the wrong shape for the question', () => {
    expect(gradeQuestion(single, { kind: 'numeric', value: 1 })).toBe(false);
    expect(gradeQuestion(numeric, { kind: 'choice', optionIds: ['a'] })).toBe(false);
  });
});

describe('gradeQuiz', () => {
  const quiz: QuizFile = {
    title: 'Mixed',
    passThreshold: 0.7,
    questions: [single, multi, numeric],
  };

  it('sums the authored points rather than counting questions', () => {
    const result = gradeQuiz(quiz, [
      { kind: 'choice', optionIds: ['b'] },
      { kind: 'choice', optionIds: ['a', 'c'] },
      { kind: 'numeric', value: 0 },
    ]);
    expect(result.maxPoints).toBe(4);
    expect(result.scorePoints).toBe(3);
    expect(result.passed).toBe(true);
  });

  it('fails below the threshold', () => {
    const result = gradeQuiz(quiz, [{ kind: 'choice', optionIds: ['b'] }, undefined, undefined]);
    expect(result.scorePoints).toBe(1);
    expect(result.passed).toBe(false);
  });

  it('passes on exactly the threshold despite float64 division', () => {
    const tenOnePointers: QuizFile = {
      title: 'Ten',
      passThreshold: 0.7,
      questions: Array.from({ length: 10 }, () => single),
    };
    const answers = Array.from({ length: 10 }, (_, index) =>
      index < 7 ? { kind: 'choice' as const, optionIds: ['b'] } : undefined,
    );
    const result = gradeQuiz(tenOnePointers, answers);
    expect(result.fraction).toBeLessThan(0.7 + 1e-12);
    expect(result.passed).toBe(true);
  });

  it('grades the shipped Module 1 quiz from its own answer key', () => {
    const quizFile = getModule('neurons')!.quiz;
    const answers = quizFile.questions.map((question) => {
      const correct = question.correct;
      if ('optionIds' in correct) return { kind: 'choice' as const, optionIds: correct.optionIds };
      if ('value' in correct) return { kind: 'numeric' as const, value: correct.value };
      return { kind: 'text' as const, text: correct.acceptable[0] ?? '' };
    });
    const result = gradeQuiz(quizFile, answers);
    expect(result.scorePoints).toBe(result.maxPoints);
    expect(result.passed).toBe(true);
  });
});
