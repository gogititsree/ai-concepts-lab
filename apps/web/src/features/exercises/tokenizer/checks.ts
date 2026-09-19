import type { TokenizerCheck, TokenizerConfig } from '@lab/shared';

import { attentionRowTaskPasses, type AttentionAnswer } from '../attention/checks';
import { neighbourTaskPasses, type NeighbourAnswer } from '../embeddings/checks';

/**
 * The `tokenize-three` check, plus the dispatcher that fans the three tabs' tasks out to
 * their own `checks.ts`.
 *
 * Each tab owns its check because each one is a different kind of claim, and keeping them
 * apart means a change to the embeddings tab cannot break the attention task. They are all
 * pure functions of (check, answer) so `test/tokenizerChecks.test.ts` can run them against
 * the shipped config with no React in sight.
 */

export type TokenizerTask = TokenizerConfig['tasks'][number];

export interface TokenizeAnswer {
  /** Sample-sentence ids the learner has actually run through the tokenizer. */
  tokenized: readonly string[];
  /** Their answer to "which one costs the most tokens?", or null if unanswered. */
  answerSentenceId: string | null;
}

export function tokenizeTaskPasses(
  check: Extract<TokenizerCheck, { kind: 'tokenize' }>,
  answer: TokenizeAnswer,
): boolean {
  // A set, because clicking the same sample three times is not three sentences.
  const distinct = new Set(answer.tokenized);
  if (distinct.size < check.sentencesTokenized) return false;
  return answer.answerSentenceId === check.answerSentenceId;
}

/** Everything the three checks between them need to see. */
export interface TokenizerMeasurements {
  tokenize: TokenizeAnswer;
  neighbour: NeighbourAnswer;
  attention: AttentionAnswer;
}

export function taskPasses(task: TokenizerTask, m: TokenizerMeasurements): boolean {
  switch (task.check.kind) {
    case 'tokenize':
      return tokenizeTaskPasses(task.check, m.tokenize);
    case 'neighbour':
      return neighbourTaskPasses(task.check, m.neighbour);
    case 'attention-row':
      return attentionRowTaskPasses(task.check, m.attention);
  }
}

/** The ids passing right now; the server's `tasks_completed` is what makes them stick. */
export function evaluateTokenizerTasks(
  config: TokenizerConfig,
  m: TokenizerMeasurements,
): string[] {
  return config.tasks.filter((task) => taskPasses(task, m)).map((task) => task.id);
}
