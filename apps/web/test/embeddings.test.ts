import { cosineSimilarity, pca, project } from '@lab/nn-core';
import { PrecomputedEmbeddingsSchema } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import { parseExerciseConfig } from '../src/features/content/exerciseConfig';
import { neighboursOf, solveAnalogy } from '../src/features/exercises/embeddings/analogy';
import {
  bundledEmbeddings,
  PRECOMPUTED_EMBEDDINGS,
  vectorsForWords,
} from '../src/features/exercises/embeddings/precomputed';
import { exerciseDetail } from './fixtures/content';

/**
 * The shipped vectors, the fallback loader, the PCA and the analogy finder — all against
 * `content/modules/03-how-llms-work/embeddings-precomputed.json` as committed.
 *
 * These assertions are on **real numbers from a real model**, which is deliberate. The
 * file is a build artefact of `pnpm content:embeddings`; if someone regenerates it with a
 * different embedding model, `king - man + woman` may stop landing on `queen`, and the
 * lesson that claims it does should go red at the same moment.
 */

const config = parseExerciseConfig('tokenizer', exerciseDetail('how-llms-work').config);
const words = config.embeddings.words.map((entry) => entry.word);

describe('the shipped fallback file', () => {
  it('validates against the shared schema and covers every configured word', () => {
    // Already parsed at import time; re-parsing proves the exported value is the file.
    expect(PrecomputedEmbeddingsSchema.safeParse(PRECOMPUTED_EMBEDDINGS).success).toBe(true);
    expect(PRECOMPUTED_EMBEDDINGS.model).toBe('nomic-embed-text');
    expect(PRECOMPUTED_EMBEDDINGS.dimensions).toBe(768);

    const { vectors, missing } = vectorsForWords(PRECOMPUTED_EMBEDDINGS, words);
    expect(missing).toEqual([]);
    expect(Object.keys(vectors)).toHaveLength(words.length);
    for (const vector of Object.values(vectors)) {
      expect(vector).toHaveLength(768);
      expect(vector.every(Number.isFinite)).toBe(true);
    }
  });

  it('is reachable by the name the content file uses', () => {
    expect(bundledEmbeddings(config.embeddings.fallbackFile)).toBe(PRECOMPUTED_EMBEDDINGS);
    expect(() => bundledEmbeddings('nope.json')).toThrow(/No bundled embeddings file/);
  });

  it('drops a word it has no vector for rather than substituting zeros', () => {
    const { vectors, missing } = vectorsForWords(PRECOMPUTED_EMBEDDINGS, ['cat', 'aardvark']);
    expect(missing).toEqual(['aardvark']);
    expect(Object.keys(vectors)).toEqual(['cat']);
  });
});

describe('PCA projection', () => {
  const data = words.map((word) => PRECOMPUTED_EMBEDDINGS.vectors[word] as number[]);

  it('is deterministic: the same vectors give byte-identical coordinates', () => {
    const first = project(pca(data, 2), data);
    const second = project(pca(data, 2), data);
    expect(second).toEqual(first);
    expect(first).toHaveLength(words.length);
    expect(first[0]).toHaveLength(2);
  });

  it('keeps only a slice of the variance, which is why the tab says so', () => {
    const model = pca(data, 2);
    expect(model.components).toHaveLength(2);
    expect(model.explained[0]).toBeGreaterThan(model.explained[1] as number);
    // 768 dimensions do not collapse into two: if this ever exceeded a half, the lesson's
    // "adjacency is a hint" caveat would be wrong.
    expect((model.explained[0] as number) + (model.explained[1] as number)).toBeLessThan(0.5);
  });
});

describe('cosine similarity on the shipped vectors', () => {
  const at = (word: string) => PRECOMPUTED_EMBEDDINGS.vectors[word] as number[];

  it('puts dog nearest to wolf, which is what the task expects', () => {
    const neighbours = neighboursOf(PRECOMPUTED_EMBEDDINGS.vectors, 'wolf', 3);
    expect(neighbours[0]?.word).toBe('dog');
    // Comfortably clear of second place, so the task is not a coin flip.
    expect(neighbours[0]?.similarity).toBeGreaterThan((neighbours[1]?.similarity as number) + 0.05);
  });

  it('agrees with the figures quoted in Lesson 3.2', () => {
    expect(cosineSimilarity(at('wolf'), at('dog'))).toBeCloseTo(0.72, 1);
    expect(cosineSimilarity(at('write'), at('read'))).toBeCloseTo(0.66, 1);
    expect(cosineSimilarity(at('cat'), at('cat'))).toBeCloseTo(1, 6);
  });

  it('excludes the word itself from its own neighbour list', () => {
    expect(neighboursOf(PRECOMPUTED_EMBEDDINGS.vectors, 'cat', 5).map((n) => n.word)).not.toContain(
      'cat',
    );
    expect(neighboursOf(PRECOMPUTED_EMBEDDINGS.vectors, 'aardvark')).toEqual([]);
  });
});

describe('the analogy finder', () => {
  it('solves king - man + woman as queen, as the lesson claims', () => {
    const { a, b, c } = config.embeddings.defaultAnalogy;
    expect([a, b, c]).toEqual(['king', 'man', 'woman']);

    const result = solveAnalogy(PRECOMPUTED_EMBEDDINGS.vectors, a, b, c, 3);
    expect(result.missing).toEqual([]);
    expect(result.neighbours[0]?.word).toBe('queen');
    expect(result.neighbours[0]?.similarity).toBeGreaterThan(0.75);
  });

  it('runs the analogy in reverse too', () => {
    const result = solveAnalogy(PRECOMPUTED_EMBEDDINGS.vectors, 'queen', 'woman', 'man', 1);
    expect(result.neighbours[0]?.word).toBe('king');
  });

  it('excludes a, b and c from the candidates', () => {
    const result = solveAnalogy(PRECOMPUTED_EMBEDDINGS.vectors, 'king', 'man', 'woman', 5);
    expect(result.neighbours.map((n) => n.word)).not.toContain('king');
    expect(result.neighbours.map((n) => n.word)).not.toContain('woman');
  });

  it('names the words it has no vector for instead of throwing', () => {
    const result = solveAnalogy(PRECOMPUTED_EMBEDDINGS.vectors, 'king', 'duke', 'woman');
    expect(result.missing).toEqual(['duke']);
    expect(result.neighbours).toEqual([]);
  });
});
