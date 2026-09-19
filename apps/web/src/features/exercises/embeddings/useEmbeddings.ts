import type { EmbeddingsConfig } from '@lab/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { apiPost, ApiError } from '../../../lib/apiClient';
import { bundledEmbeddings, vectorsForWords } from './precomputed';

/**
 * Where the vectors come from, and the honest label that goes with them.
 *
 * Live vectors from `POST /api/v1/model/embed` are preferred — they are the *point* of
 * having a local model, and a learner who has Ollama running should see it working. But
 * the deployed instance runs `MODEL_PROVIDER=none` and most people have no Ollama, so a
 * 503 is the ordinary case and not an error state. The query therefore:
 *
 *  - never retries (a `MODEL_UNAVAILABLE` will not become available on the second ask,
 *    and the tab must not sit blank while it finds that out),
 *  - resolves rather than throws: the fallback is a *result*, not a recovery, and
 *  - carries `source` so the UI can say which vectors are on screen. Unlabelled numbers
 *    from an unknown provenance are worse than no numbers.
 *
 * `MODEL_PROVIDER=fake` deliberately gets the fallback too: the fake provider's hashed
 * pseudo-embeddings are the right shape and meaningless as geometry, so a scatter drawn
 * from them would teach something false. `source: 'ollama'` in the response is the only
 * thing that counts as real.
 */

const EmbedResponseSchema = z.object({
  embeddings: z.array(z.array(z.number())),
  model: z.string(),
  source: z.literal('ollama'),
});

export type EmbeddingSource = 'ollama' | 'precomputed';

export interface EmbeddingSet {
  source: EmbeddingSource;
  model: string;
  /** Word -> vector, for the words the source actually had. */
  vectors: Record<string, number[]>;
  /** Words the source did not cover; the scatter omits them and the tab says so. */
  missing: string[];
  /** Why the live call did not happen or did not work, for the "precomputed" caption. */
  reason?: string;
}

function fallback(config: EmbeddingsConfig, reason?: string): EmbeddingSet {
  const file = bundledEmbeddings(config.fallbackFile);
  const { vectors, missing } = vectorsForWords(
    file,
    config.words.map((entry) => entry.word),
  );
  return {
    source: 'precomputed',
    model: file.model,
    vectors,
    missing,
    ...(reason ? { reason } : {}),
  };
}

export async function fetchEmbeddings(config: EmbeddingsConfig): Promise<EmbeddingSet> {
  const words = config.words.map((entry) => entry.word);
  try {
    const response = await apiPost('/model/embed', {
      body: { texts: words },
      schema: EmbedResponseSchema,
    });
    if (response.embeddings.length !== words.length) {
      return fallback(config, 'the model returned the wrong number of vectors');
    }
    const vectors: Record<string, number[]> = {};
    words.forEach((word, index) => {
      const vector = response.embeddings[index];
      if (vector && vector.length > 0) vectors[word] = vector;
    });
    return { source: 'ollama', model: response.model, vectors, missing: [] };
  } catch (error) {
    const reason =
      error instanceof ApiError
        ? error.isModelUnavailable
          ? 'no model provider is reachable'
          : error.isUnauthenticated
            ? 'not signed in'
            : error.message
        : 'the request failed';
    return fallback(config, reason);
  }
}

export function useEmbeddings(config: EmbeddingsConfig) {
  // A literal key: `lib/queryClient.ts` owns the shared `queryKeys` map and this is the
  // only consumer of this endpoint, so adding an entry there would be a wider change than
  // the feature justifies.
  return useQuery({
    queryKey: ['model', 'embed', config.fallbackFile, config.words.length],
    queryFn: () => fetchEmbeddings(config),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    // The precomputed vectors are always available, so the tab has something to draw on
    // the very first render and never flashes an empty plot.
    placeholderData: () => fallback(config),
  });
}
