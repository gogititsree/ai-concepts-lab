import { describe, expect, it } from 'vitest';

import { parseExerciseConfig } from '../src/features/content/exerciseConfig';
import { attentionRowTaskPasses } from '../src/features/exercises/attention/checks';
import { neighbourTaskPasses } from '../src/features/exercises/embeddings/checks';
import {
  evaluateTokenizerTasks,
  tokenizeTaskPasses,
  type TokenizerMeasurements,
} from '../src/features/exercises/tokenizer/checks';
import { exerciseDetail } from './fixtures/content';

/**
 * The three auto-checks, against the **shipped** Module 3 config rather than an invented
 * one. If someone edits `content/modules/03-how-llms-work/exercises.json` — renames a
 * sample sentence, moves `it` in the attention example, changes the target word — this is
 * the file that notices, and it notices at the level of "the task is now unpassable"
 * rather than "a JSON key changed".
 */

const config = parseExerciseConfig('tokenizer', exerciseDetail('how-llms-work').config);

const check = <K extends 'tokenize' | 'neighbour' | 'attention-row'>(kind: K) => {
  const task = config.tasks.find((entry) => entry.check.kind === kind);
  if (!task) throw new Error(`The shipped config has no ${kind} task`);
  return task.check as Extract<(typeof config.tasks)[number]['check'], { kind: K }>;
};

const NOTHING: TokenizerMeasurements = {
  tokenize: { tokenized: [], answerSentenceId: null },
  neighbour: { word: null },
  attention: { keyIndex: null },
};

describe('tokenize-three', () => {
  const tokenize = check('tokenize');

  it('needs every sample tokenized *and* the right answer', () => {
    const all = ['in-domain', 'out-of-domain', 'digits-and-symbols'];
    expect(
      tokenizeTaskPasses(tokenize, { tokenized: all, answerSentenceId: 'digits-and-symbols' }),
    ).toBe(true);

    // Right answer, not enough work shown.
    expect(
      tokenizeTaskPasses(tokenize, {
        tokenized: ['digits-and-symbols'],
        answerSentenceId: 'digits-and-symbols',
      }),
    ).toBe(false);

    // All the work, wrong answer.
    expect(tokenizeTaskPasses(tokenize, { tokenized: all, answerSentenceId: 'in-domain' })).toBe(
      false,
    );

    // Unanswered.
    expect(tokenizeTaskPasses(tokenize, { tokenized: all, answerSentenceId: null })).toBe(false);
  });

  it('counts distinct sentences, not clicks', () => {
    expect(
      tokenizeTaskPasses(tokenize, {
        tokenized: ['in-domain', 'in-domain', 'in-domain'],
        answerSentenceId: 'digits-and-symbols',
      }),
    ).toBe(false);
  });

  it('expects the digit string, which is the answer at every merge setting', () => {
    expect(tokenize.answerSentenceId).toBe('digits-and-symbols');
    expect(tokenize.sentencesTokenized).toBe(3);
  });
});

describe('find-neighbour', () => {
  const neighbour = check('neighbour');

  it('accepts the authored answer, case- and space-insensitively', () => {
    const accepted = neighbour.acceptable[0] as string;
    for (const word of [accepted, accepted.toUpperCase(), `  ${accepted} `]) {
      expect(neighbourTaskPasses(neighbour, { word })).toBe(true);
    }
  });

  it('rejects a different word, the target itself, and no answer', () => {
    expect(neighbourTaskPasses(neighbour, { word: 'tiger' })).toBe(false);
    expect(neighbourTaskPasses(neighbour, { word: neighbour.targetWord })).toBe(false);
    expect(neighbourTaskPasses(neighbour, { word: null })).toBe(false);
  });

  it('asks about wolf and expects dog', () => {
    expect(neighbour.targetWord).toBe('wolf');
    expect(neighbour.acceptable).toContain('dog');
  });
});

describe('attention-row', () => {
  const attention = check('attention-row');

  it('compares indices, so the two "the"s are distinguishable', () => {
    expect(attentionRowTaskPasses(attention, { keyIndex: attention.expectedKeyIndex })).toBe(true);
    expect(attentionRowTaskPasses(attention, { keyIndex: 0 })).toBe(false);
    expect(attentionRowTaskPasses(attention, { keyIndex: null })).toBe(false);
  });

  it('points at "it" as the query and "mat" as the answer', () => {
    expect(config.attention.words[attention.queryIndex]).toBe('it');
    expect(config.attention.words[attention.expectedKeyIndex]).toBe('mat');
  });
});

describe('evaluateTokenizerTasks', () => {
  it('reports nothing when nothing has been answered', () => {
    expect(evaluateTokenizerTasks(config, NOTHING)).toEqual([]);
  });

  it('reports exactly the ids that pass, and two of three completes the exercise', () => {
    const passing = evaluateTokenizerTasks(config, {
      tokenize: {
        tokenized: ['in-domain', 'out-of-domain', 'digits-and-symbols'],
        answerSentenceId: 'digits-and-symbols',
      },
      neighbour: { word: 'dog' },
      attention: { keyIndex: 0 },
    });
    expect(passing).toEqual(['tokenize-three', 'find-neighbour']);

    const rule = exerciseDetail('how-llms-work').completionRule;
    expect(rule).toEqual({ type: 'tasks', required: 2 });
    expect(passing.length).toBeGreaterThanOrEqual(2);
  });

  it('reports all three when all three are right', () => {
    expect(
      evaluateTokenizerTasks(config, {
        tokenize: {
          tokenized: ['in-domain', 'out-of-domain', 'digits-and-symbols'],
          answerSentenceId: 'digits-and-symbols',
        },
        neighbour: { word: 'dog' },
        attention: { keyIndex: 5 },
      }),
    ).toEqual(['tokenize-three', 'find-neighbour', 'attention-row']);
  });
});
