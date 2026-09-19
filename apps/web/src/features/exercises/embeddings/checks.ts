import type { TokenizerCheck } from '@lab/shared';

/**
 * The `find-neighbour` check: did the learner name the word nearest to the target?
 *
 * `acceptable` is a list rather than a single word because the tab draws live vectors
 * from `POST /model/embed` when Ollama is up and the shipped ones otherwise. Both come
 * from `nomic-embed-text`, so they agree on `wolf → dog` (cosine 0.72, well clear of
 * `tiger` at 0.62) — but authoring a list means a near-tie in some future word pair is a
 * content edit rather than a learner who cannot pass a task they answered correctly.
 *
 * Matching is case- and whitespace-insensitive because the answer can be typed as well as
 * clicked, and "Dog " is not a wrong answer.
 */

export interface NeighbourAnswer {
  /** The word the learner reported as nearest, or null if they have not said. */
  word: string | null;
}

const normalize = (word: string): string => word.trim().toLowerCase();

export function neighbourTaskPasses(
  check: Extract<TokenizerCheck, { kind: 'neighbour' }>,
  answer: NeighbourAnswer,
): boolean {
  if (!answer.word) return false;
  const given = normalize(answer.word);
  // Answering with the target itself is the degenerate "nearest word is itself"; the
  // scatter excludes it from the neighbour list, and so does this.
  if (given === normalize(check.targetWord)) return false;
  return check.acceptable.some((word) => normalize(word) === given);
}
