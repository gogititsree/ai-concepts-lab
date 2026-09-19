import type { QuizOption } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import {
  describeCorrect,
  formatPercent,
  isAnswered,
  selectedOptionIds,
} from '../src/lib/quizGrading';
import { quizDetail } from './fixtures/content';

/**
 * This file used to test a grader that ran in the browser against an answer key in the
 * bundle. M7 moved grading to `POST /quizzes/:id/attempts`, and the API's own unit suite
 * (`apps/api/test/grading.test.ts`) now owns every rule, kind by kind and boundary by
 * boundary. What is left on this side is the presentation of a result that has already
 * been graded — and one assertion that the answers really are gone.
 */

const options: QuizOption[] = [
  { id: 'a', textMd: 'Rotates the line' },
  { id: 'b', textMd: 'Shifts the line' },
  { id: 'c', textMd: 'Nothing at all' },
];

describe('formatPercent', () => {
  it('rounds to whole percent', () => {
    expect(formatPercent(0.7)).toBe('70 %');
    expect(formatPercent(0.875)).toBe('88 %');
    expect(formatPercent(0)).toBe('0 %');
    expect(formatPercent(1)).toBe('100 %');
  });
});

describe('describeCorrect', () => {
  it('names the option rather than its id', () => {
    expect(describeCorrect('single_choice', { optionIds: ['b'] }, options)).toBe('Shifts the line');
    expect(describeCorrect('multi_choice', { optionIds: ['a', 'c'] }, options)).toBe(
      'Rotates the line + Nothing at all',
    );
  });

  it('falls back to the id when the options are missing', () => {
    expect(describeCorrect('single_choice', { optionIds: ['z'] }, options)).toBe('z');
    expect(describeCorrect('single_choice', { optionIds: ['b'] }, null)).toBe('b');
  });

  it('shows a numeric tolerance only when there is one', () => {
    expect(describeCorrect('numeric', { value: 0.7, tolerance: 0.005 }, null)).toBe(
      '0.7 (± 0.005)',
    );
    expect(describeCorrect('numeric', { value: 17, tolerance: 0 }, null)).toBe('17');
  });

  it('lists every acceptable short-text answer', () => {
    expect(
      describeCorrect(
        'short_text',
        { acceptable: ['softmax', 'the softmax'], normalize: 'lower_trim' },
        null,
      ),
    ).toBe('softmax / the softmax');
  });
});

describe('isAnswered', () => {
  it('is false for nothing, an empty selection, a blank number and blank text', () => {
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered({ optionIds: [] })).toBe(false);
    expect(isAnswered({ value: null })).toBe(false);
    expect(isAnswered({ text: '   ' })).toBe(false);
  });

  it('is true once there is something to submit', () => {
    expect(isAnswered({ optionIds: ['a'] })).toBe(true);
    expect(isAnswered({ value: 0 })).toBe(true);
    expect(isAnswered({ text: 'softmax' })).toBe(true);
  });
});

describe('selectedOptionIds', () => {
  it('returns the selection, or nothing for the other answer shapes', () => {
    expect(selectedOptionIds({ optionIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(selectedOptionIds({ value: 1 })).toEqual([]);
    expect(selectedOptionIds(undefined)).toEqual([]);
  });
});

describe('the quiz the browser receives', () => {
  it('contains no answer key at all', () => {
    for (const slug of ['neurons', 'neural-networks', 'how-llms-work']) {
      const serialised = JSON.stringify(quizDetail(slug));
      expect(serialised.toLowerCase(), slug).not.toContain('explanation');
      expect(serialised, slug).not.toContain('"correct"');
      expect(serialised, slug).not.toContain('acceptable');
      expect(serialised, slug).not.toContain('tolerance');
    }
  });
});
