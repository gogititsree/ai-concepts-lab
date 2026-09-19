import type { TokenizerCheck } from '@lab/shared';

/**
 * The `attention-row` check: which key does the query row attend to most?
 *
 * The answer is an **index**, not a word, and that is the whole reason this function
 * exists rather than a string comparison. The sample sentence is
 * `the cat sat on the mat because it` — two of the eight words are `the`, and a learner
 * who clicks the first one has not answered the same question as one who clicks the
 * fifth. Indices also survive an "edit vectors" session that changes the numbers but not
 * the sentence.
 *
 * Note what is *not* checked: whether the learner had the √d_k toggle on or the
 * temperature at 1. Those change the weights but not the argmax of this row — `mat` wins
 * at every setting the sliders allow — so insisting on a particular one would be a
 * gotcha rather than a check.
 */

export interface AttentionAnswer {
  /** Index into `attention.words` of the key the learner picked, or null. */
  keyIndex: number | null;
}

export function attentionRowTaskPasses(
  check: Extract<TokenizerCheck, { kind: 'attention-row' }>,
  answer: AttentionAnswer,
): boolean {
  return answer.keyIndex !== null && answer.keyIndex === check.expectedKeyIndex;
}
