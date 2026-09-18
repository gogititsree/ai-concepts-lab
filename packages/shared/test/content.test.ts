import { describe, expect, it } from 'vitest';

import {
  ExercisesFileSchema,
  LessonFrontmatterSchema,
  ModuleFileSchema,
  parseFrontmatter,
  QuizFileSchema,
} from '../src/content.js';

describe('ModuleFileSchema', () => {
  const valid = {
    slug: 'neurons',
    title: 'Neurons & perceptrons',
    summary: 'A neuron is a weighted sum plus a threshold.',
    orderIndex: 1,
  };

  it('applies defaults for the optional flags', () => {
    expect(ModuleFileSchema.parse(valid)).toEqual({
      ...valid,
      requiresModel: false,
      isPublished: true,
    });
  });

  it('rejects a non-kebab-case slug', () => {
    expect(ModuleFileSchema.safeParse({ ...valid, slug: 'How LLMs Work' }).success).toBe(false);
  });

  it('rejects unknown keys, because they are almost always typos', () => {
    const result = ModuleFileSchema.safeParse({ ...valid, requiresModal: true });
    expect(result.success).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  const file = `---
slug: what-a-neuron-computes
title: What a neuron computes
orderIndex: 1
estimatedMinutes: 10
---

# What a neuron computes

Body text.`;

  it('splits the frontmatter from the body and coerces scalars', () => {
    const { frontmatter, body } = parseFrontmatter(file);
    expect(frontmatter).toEqual({
      slug: 'what-a-neuron-computes',
      title: 'What a neuron computes',
      orderIndex: 1,
      estimatedMinutes: 10,
    });
    expect(body.startsWith('# What a neuron computes')).toBe(true);
  });

  it('keeps colons inside a value (titles like "Text to tokens: BPE")', () => {
    const { frontmatter } = parseFrontmatter('---\ntitle: Text to tokens: BPE\n---\nbody');
    expect(frontmatter.title).toBe('Text to tokens: BPE');
  });

  it('handles CRLF, a BOM, comments, quotes and booleans', () => {
    const raw = '﻿---\r\n# a comment\r\nslug: "a-b"\r\ndraft: false\r\n---\r\nbody\r\n';
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({ slug: 'a-b', draft: false });
    expect(body).toBe('body');
  });

  it('throws when the fence is missing', () => {
    expect(() => parseFrontmatter('# no frontmatter')).toThrow(/missing frontmatter/);
  });

  it('throws on a line that is not key: value', () => {
    expect(() => parseFrontmatter('---\njust some words\n---\nbody')).toThrow(/key: value/);
  });

  it('feeds LessonFrontmatterSchema, which defaults estimatedMinutes', () => {
    const { frontmatter } = parseFrontmatter('---\nslug: a\ntitle: A\norderIndex: 1\n---\nbody');
    expect(LessonFrontmatterSchema.parse(frontmatter).estimatedMinutes).toBe(10);
  });
});

describe('ExercisesFileSchema', () => {
  const exercise = {
    slug: 'perceptron-playground',
    title: 'Perceptron playground',
    kind: 'perceptron',
    orderIndex: 1,
    config: { defaultLr: 0.1 },
    completionRule: { type: 'tasks', required: 2 },
  };

  it('accepts a minimal exercise and an optional lesson anchor', () => {
    expect(ExercisesFileSchema.parse([exercise])).toHaveLength(1);
    expect(ExercisesFileSchema.safeParse([{ ...exercise, lessonSlug: 'a-lesson' }]).success).toBe(
      true,
    );
  });

  it('rejects an unknown exercise kind', () => {
    expect(ExercisesFileSchema.safeParse([{ ...exercise, kind: 'transformer' }]).success).toBe(
      false,
    );
  });

  it('rejects a completion rule that is neither tasks nor manual', () => {
    expect(
      ExercisesFileSchema.safeParse([{ ...exercise, completionRule: { type: 'vibes' } }]).success,
    ).toBe(false);
    expect(
      ExercisesFileSchema.safeParse([{ ...exercise, completionRule: { type: 'manual' } }]).success,
    ).toBe(true);
  });

  it('rejects an empty file', () => {
    expect(ExercisesFileSchema.safeParse([]).success).toBe(false);
  });
});

describe('QuizFileSchema', () => {
  const quiz = (question: unknown) => ({ title: 'Quiz', questions: [question] });

  const singleChoice = {
    kind: 'single_choice',
    promptMd: 'What does it output?',
    options: [
      { id: 'a', textMd: '0' },
      { id: 'b', textMd: '1' },
    ],
    correct: { optionIds: ['b'] },
    explanationMd: 'z = 0 and 0 >= 0.',
  };

  it('defaults passThreshold to 0.7 and points to 1', () => {
    const parsed = QuizFileSchema.parse(quiz(singleChoice));
    expect(parsed.passThreshold).toBe(0.7);
    expect(parsed.questions[0]?.points).toBe(1);
  });

  it('requires exactly one correct id for single_choice', () => {
    const twoAnswers = { ...singleChoice, correct: { optionIds: ['a', 'b'] } };
    expect(QuizFileSchema.safeParse(quiz(twoAnswers)).success).toBe(false);
  });

  it('allows several correct ids for multi_choice', () => {
    const multi = { ...singleChoice, kind: 'multi_choice', correct: { optionIds: ['a', 'b'] } };
    expect(QuizFileSchema.safeParse(quiz(multi)).success).toBe(true);
  });

  it('rejects a correct option id that no option declares', () => {
    const ghost = { ...singleChoice, correct: { optionIds: ['z'] } };
    const result = QuizFileSchema.safeParse(quiz(ghost));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unknown option id');
  });

  it('requires options for choice kinds and forbids them otherwise', () => {
    const { options: _dropped, ...noOptions } = singleChoice;
    expect(QuizFileSchema.safeParse(quiz(noOptions)).success).toBe(false);

    const numericWithOptions = {
      ...singleChoice,
      kind: 'numeric',
      correct: { value: 1, tolerance: 0.1 },
    };
    expect(QuizFileSchema.safeParse(quiz(numericWithOptions)).success).toBe(false);
  });

  it('matches the correct shape to the question kind', () => {
    const numeric = {
      kind: 'numeric',
      promptMd: 'Compute it.',
      correct: { value: -0.032, tolerance: 0.005 },
      explanationMd: 'Chain rule.',
    };
    expect(QuizFileSchema.safeParse(quiz(numeric)).success).toBe(true);
    // A choice-shaped `correct` on a numeric question is the mistake this catches.
    expect(
      QuizFileSchema.safeParse(quiz({ ...numeric, correct: { optionIds: ['a'] } })).success,
    ).toBe(false);

    const shortText = {
      kind: 'short_text',
      promptMd: 'Name the operation.',
      correct: { acceptable: ['softmax'] },
      explanationMd: 'Softmax normalises each row.',
    };
    const parsed = QuizFileSchema.parse(quiz(shortText));
    expect((parsed.questions[0]?.correct as { normalize: string }).normalize).toBe('lower_trim');
  });
});
