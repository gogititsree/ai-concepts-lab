import { ExerciseKindSchema, QuizQuestionSchema } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import {
  getExercise,
  getLesson,
  getModule,
  modules,
  parseExerciseConfig,
} from '../src/content/static';

/**
 * The loader validates at import time, so a broken content file fails this file's import and
 * every assertion below is really a second opinion about the *shape* of the curriculum.
 */
describe('static content loader', () => {
  it('loads all six modules in order', () => {
    expect(modules).toHaveLength(6);
    expect(modules.map((module) => module.orderIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(modules.map((module) => module.slug)).toEqual([
      'neurons',
      'neural-networks',
      'how-llms-work',
      'prompting',
      'agents',
      'harnesses',
    ]);
  });

  it('gives every module a quiz, an exercise and at least one lesson', () => {
    for (const module of modules) {
      expect(module.lessons.length).toBeGreaterThan(0);
      expect(module.exercises.length).toBeGreaterThan(0);
      expect(module.quiz.questions.length).toBeGreaterThan(0);
      expect(ExerciseKindSchema.parse(module.exercises[0]?.kind)).toBeTruthy();
      for (const question of module.quiz.questions) {
        expect(QuizQuestionSchema.safeParse(question).success).toBe(true);
      }
    }
  });

  it('has the written-out curriculum for modules 1 and 2', () => {
    expect(getModule('neurons')?.lessons).toHaveLength(3);
    expect(getModule('neural-networks')?.lessons).toHaveLength(4);
    expect(getModule('neurons')?.quiz.questions.length).toBeGreaterThanOrEqual(6);
    expect(getModule('neural-networks')?.quiz.questions.length).toBeGreaterThanOrEqual(6);
  });

  it('parses lesson frontmatter and keeps the Markdown body', () => {
    const found = getLesson('neurons', 'what-a-neuron-computes');
    expect(found?.lesson.title).toBe('What a neuron computes');
    expect(found?.lesson.estimatedMinutes).toBeGreaterThan(0);
    expect(found?.lesson.bodyMd).toContain('# What a neuron computes');
    // Frontmatter must not leak into the rendered body.
    expect(found?.lesson.bodyMd.startsWith('---')).toBe(false);
  });

  it('links lessons into a prev/next chain', () => {
    const first = getLesson('neurons', 'what-a-neuron-computes');
    expect(first?.previous).toBeUndefined();
    expect(first?.next?.slug).toBe('the-perceptron-rule');
    const last = getLesson('neurons', 'reading-the-code');
    expect(last?.next).toBeUndefined();
    expect(last?.previous?.slug).toBe('the-perceptron-rule');
  });

  it('carries the KaTeX and callout conventions the renderer relies on', () => {
    const written = [
      ...(getModule('neurons')?.lessons ?? []),
      ...(getModule('neural-networks')?.lessons ?? []),
    ];
    expect(written).toHaveLength(7);
    for (const lesson of written) {
      expect(lesson.bodyMd).toMatch(/\$/);
      expect(lesson.bodyMd).toContain('Where is this in the code?');
    }
    // The last lesson of each written module ends with the observability box.
    expect(getModule('neurons')?.lessons.at(-1)?.bodyMd).toContain('What to measure');
    expect(getModule('neural-networks')?.lessons.at(-1)?.bodyMd).toContain('What to measure');
  });

  it('exposes typed exercise configs for the kinds M3 implements', () => {
    const perceptron = parseExerciseConfig('perceptron', getExercise('neurons')!.config);
    expect(perceptron.datasets).toContain('xor');
    expect(perceptron.tasks.map((task) => task.id)).toEqual(['separate-blobs', 'try-xor']);

    const mlp = parseExerciseConfig('mlp', getExercise('neural-networks')!.config);
    expect(mlp.hiddenSizes).toContain(2);
    expect(mlp.tasks.map((task) => task.id)).toEqual([
      'xor-converge',
      'circle-hidden-size',
      'step-through',
    ]);
  });

  it('returns undefined for slugs that do not exist', () => {
    expect(getModule('nope')).toBeUndefined();
    expect(getLesson('neurons', 'nope')).toBeUndefined();
    expect(getLesson('nope', 'nope')).toBeUndefined();
  });
});
