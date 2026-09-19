import { cosineSimilarity } from '@lab/nn-core';

/**
 * Nearest-neighbour search and the `a - b + c` analogy, both by cosine similarity.
 *
 * Pure functions over a `Record<word, vector>`, so `test/embeddingsTab.test.ts` can run
 * them against the *shipped* vectors and assert on real answers
 * (`king - man + woman → queen`, cosine 0.79) rather than on invented ones.
 *
 * The exclusion rule is the part worth stating out loud, because it is what makes the
 * famous demo work at all: the three input words are removed from the candidate list. Do
 * not exclude them and `king - man + woman` very often returns `king`, since subtracting
 * and adding two moderately similar vectors barely moves you. That is not cheating, but
 * it is a thumb on the scale, and a learner should be told rather than impressed.
 */

export interface Neighbour {
  word: string;
  similarity: number;
}

export function nearestWords(
  vectors: Record<string, number[]>,
  query: readonly number[],
  { exclude = [] as readonly string[], limit = 5 } = {},
): Neighbour[] {
  const excluded = new Set(exclude);
  const scored: Neighbour[] = [];
  for (const [word, vector] of Object.entries(vectors)) {
    if (excluded.has(word)) continue;
    scored.push({ word, similarity: cosineSimilarity(query, vector) });
  }
  // Ties broken alphabetically so the list is stable between renders and between runs.
  scored.sort((a, b) => b.similarity - a.similarity || a.word.localeCompare(b.word));
  return scored.slice(0, limit);
}

/** The neighbours of a word, by name. Empty when the word has no vector. */
export function neighboursOf(
  vectors: Record<string, number[]>,
  word: string,
  limit = 5,
): Neighbour[] {
  const vector = vectors[word];
  if (!vector) return [];
  return nearestWords(vectors, vector, { exclude: [word], limit });
}

export interface AnalogyResult {
  neighbours: Neighbour[];
  /** Words that were asked for but have no vector; the UI names them. */
  missing: string[];
}

/** `a - b + c`, then the nearest words to the result with a, b and c excluded. */
export function solveAnalogy(
  vectors: Record<string, number[]>,
  a: string,
  b: string,
  c: string,
  limit = 3,
): AnalogyResult {
  const missing = [a, b, c].filter((word) => !vectors[word]);
  if (missing.length > 0) return { neighbours: [], missing };

  const va = vectors[a] as number[];
  const vb = vectors[b] as number[];
  const vc = vectors[c] as number[];
  const target = va.map((value, i) => value - (vb[i] ?? 0) + (vc[i] ?? 0));

  return { neighbours: nearestWords(vectors, target, { exclude: [a, b, c], limit }), missing: [] };
}
