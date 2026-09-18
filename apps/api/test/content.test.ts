import { describe, expect, it } from 'vitest';

import { ContentError, loadAllModules, loadModule } from '../src/db/content.js';
import { contentId, CONTENT_NAMESPACE, uuidV5 } from '../src/db/uuid5.js';

describe('uuidV5', () => {
  it('matches known vectors for the standard DNS namespace', () => {
    // Cross-checked against Python's `uuid.uuid5(uuid.NAMESPACE_DNS, name)`, i.e. an
    // independent RFC 4122 implementation -- not against this code's own output.
    const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuidV5('www.example.org', DNS)).toBe('74738ff5-5367-5958-9aee-98fffdcd1876');
    expect(uuidV5('python.org', DNS)).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('sets the version and variant bits', () => {
    const id = uuidV5('anything');
    expect(id[14]).toBe('5');
    expect('89ab').toContain(id[19]);
  });

  it('is deterministic and collision-free across id kinds', () => {
    expect(contentId.module('neurons')).toBe(contentId.module('neurons'));
    // A module and a quiz for the same slug must not share an id.
    expect(contentId.module('neurons')).not.toBe(contentId.quiz('neurons'));
    expect(contentId.lesson('neurons', 'a')).not.toBe(contentId.exercise('neurons', 'a'));
  });

  it('pins the namespace: changing it would orphan every progress row', () => {
    expect(CONTENT_NAMESPACE).toBe('582d78c7-e4c3-40b3-9548-db3c21a84a5d');
    expect(contentId.module('neurons')).toBe(uuidV5('module:neurons', CONTENT_NAMESPACE));
  });
});

describe('content loader', () => {
  it('loads and validates all six modules from content/', async () => {
    const modules = await loadAllModules();

    expect(modules.map((m) => m.module.slug)).toEqual([
      'neurons',
      'neural-networks',
      'how-llms-work',
      'prompting',
      'agents',
      'harnesses',
    ]);
    expect(modules.map((m) => m.module.orderIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    // Modules 4-6 need the local model; 1-3 run entirely in the browser.
    expect(modules.map((m) => m.module.requiresModel)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);

    for (const m of modules) {
      expect(m.lessons.length).toBeGreaterThanOrEqual(1);
      expect(m.exercises.length).toBeGreaterThanOrEqual(1);
      expect(m.quiz.questions.length).toBeGreaterThanOrEqual(1);
      expect(m.quiz.passThreshold).toBe(0.7);
      for (const lesson of m.lessons) expect(lesson.bodyMd.length).toBeGreaterThan(100);
    }
  });

  it('names the offending file when a module directory is missing', async () => {
    await expect(loadModule('99-nope', 'content/modules')).rejects.toThrow(/99-nope/);
  });

  it('throws a ContentError that carries the file path', () => {
    const error = new ContentError('/tmp/quiz.json', 'questions.0.correct: required');
    expect(error.file).toBe('/tmp/quiz.json');
    expect(error.message).toContain('/tmp/quiz.json');
  });
});
