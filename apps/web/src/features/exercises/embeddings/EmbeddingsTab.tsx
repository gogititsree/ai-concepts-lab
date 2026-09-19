import { cosineSimilarity, pca, project } from '@lab/nn-core';
import type { EmbeddingsConfig } from '@lab/shared';
import { useMemo, useState } from 'react';

import { Button, Eyebrow, Panel, Readout } from '../../../components/ui';
import { neighboursOf, solveAnalogy } from './analogy';
import type { NeighbourAnswer } from './checks';
import { EmbeddingScatter, type ScatterPoint } from './EmbeddingScatter';
import { useEmbeddings } from './useEmbeddings';

/**
 * Tab 2: 42 words, projected to 2-D by PCA, with cosine similarity on demand and an
 * analogy box.
 *
 * The PCA runs on whichever vectors arrived — live from Ollama or the shipped fallback —
 * so switching source re-projects rather than re-scaling, and the plot can genuinely look
 * different. That is why the source label is next to the plot rather than in a tooltip.
 */

export interface EmbeddingsTabProps {
  config: EmbeddingsConfig;
  answer: NeighbourAnswer;
  onAnswerChange: (answer: NeighbourAnswer) => void;
  /** The word the `find-neighbour` task asks about, if the task is in this exercise. */
  targetWord?: string;
}

export function EmbeddingsTab({ config, answer, onAnswerChange, targetWord }: EmbeddingsTabProps) {
  const query = useEmbeddings(config);
  const set = query.data;

  const [selected, setSelected] = useState<string[]>([]);
  const [analogy, setAnalogy] = useState(config.defaultAnalogy);

  const clusterByWord = useMemo(
    () => new Map(config.words.map((entry) => [entry.word, entry.cluster])),
    [config.words],
  );

  /**
   * PCA is deterministic (seeded start vector, stable sign convention), so this memo is
   * a pure cache keyed on the vectors, not a source of drift between renders.
   */
  const points = useMemo<ScatterPoint[]>(() => {
    if (!set) return [];
    const words = Object.keys(set.vectors);
    if (words.length < 2) return [];
    const data = words.map((word) => set.vectors[word] as number[]);
    const model = pca(data, 2);
    const projected = project(model, data);
    return words.map((word, index) => ({
      word,
      cluster: clusterByWord.get(word) ?? 'other',
      x: projected[index]?.[0] ?? 0,
      // A rank-deficient projection can return one column; 0 puts those on the axis
      // rather than dropping the word off the plot.
      y: projected[index]?.[1] ?? 0,
    }));
  }, [set, clusterByWord]);

  const explained = useMemo(() => {
    if (!set) return null;
    const words = Object.keys(set.vectors);
    if (words.length < 2) return null;
    const model = pca(
      words.map((word) => set.vectors[word] as number[]),
      2,
    );
    return model.explained;
  }, [set]);

  const pairSimilarity = useMemo(() => {
    if (!set || selected.length !== 2) return null;
    const [a, b] = selected as [string, string];
    const va = set.vectors[a];
    const vb = set.vectors[b];
    if (!va || !vb) return null;
    return cosineSimilarity(va, vb);
  }, [set, selected]);

  const analogyResult = useMemo(
    () => (set ? solveAnalogy(set.vectors, analogy.a, analogy.b, analogy.c, 3) : null),
    [set, analogy],
  );

  const targetNeighbours = useMemo(
    () => (set && targetWord ? neighboursOf(set.vectors, targetWord, config.neighbourCount) : []),
    [set, targetWord, config.neighbourCount],
  );

  const toggle = (word: string) =>
    setSelected((current) =>
      current.includes(word)
        ? current.filter((entry) => entry !== word)
        : // Keep at most two: the readout is a pairwise cosine, so a third click means
          // "start a new pair with this one".
          [...current, word].slice(-2),
    );

  if (!set) {
    return (
      <Panel className="p-6">
        <p className="text-muted text-sm">Loading vectors…</p>
      </Panel>
    );
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <Panel className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Eyebrow>PCA projection</Eyebrow>
          <span className="readout text-muted text-xs" data-testid="embedding-source">
            {set.source === 'ollama'
              ? `live from Ollama · ${set.model}`
              : `precomputed · ${set.model}`}
          </span>
        </div>
        <p className="text-muted mt-1 mb-3 text-xs leading-5">
          {set.source === 'precomputed'
            ? `Shipped vectors${set.reason ? ` (${set.reason})` : ''}. Identical model, generated once by \`pnpm content:embeddings\`.`
            : 'Generated just now by the local model.'}
          {explained && (
            <>
              {' '}
              The two axes keep{' '}
              <strong>
                {((explained[0] ?? 0) * 100).toFixed(1)} % and{' '}
                {((explained[1] ?? 0) * 100).toFixed(1)} %
              </strong>{' '}
              of the variance, so adjacency here is a hint — read the cosine.
            </>
          )}
        </p>

        <EmbeddingScatter
          points={points}
          selected={selected}
          onToggle={toggle}
          highlighted={[analogy.a, analogy.b, analogy.c]}
        />

        {set.missing.length > 0 && (
          <p className="text-muted mt-2 text-xs">
            No vector for: {set.missing.join(', ')}. Regenerate with{' '}
            <code className="bg-sunk border-rule rounded border px-1">pnpm content:embeddings</code>
            .
          </p>
        )}
      </Panel>

      <div className="space-y-5">
        <Panel className="p-4">
          <Eyebrow>Cosine similarity</Eyebrow>
          <p className="text-muted mt-1 text-xs leading-5">
            Click two words on the plot. Cosine uses all{' '}
            {set.vectors[points[0]?.word ?? '']?.length ?? 0} dimensions, not the two on screen.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Readout
              label="Pair"
              value={selected.length === 2 ? selected.join(' · ') : selected.join('') || '—'}
            />
            <Readout
              label="cos"
              value={pairSimilarity === null ? '—' : pairSimilarity.toFixed(3)}
            />
            {selected.length > 0 && (
              <Button variant="ghost" onClick={() => setSelected([])}>
                Clear
              </Button>
            )}
          </div>
        </Panel>

        <Panel className="p-4">
          <Eyebrow>Analogy: a − b + c</Eyebrow>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(['a', 'b', 'c'] as const).map((slot) => (
              <label key={slot} className="block">
                <span className="eyebrow">{slot}</span>
                <input
                  className="border-rule bg-surface readout mt-1 w-full rounded-md border px-2 py-1 text-sm"
                  value={analogy[slot]}
                  aria-label={`analogy term ${slot}`}
                  onChange={(event) =>
                    setAnalogy((current) => ({
                      ...current,
                      [slot]: event.target.value.trim().toLowerCase(),
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <div className="mt-3" data-testid="analogy-result">
            {analogyResult && analogyResult.missing.length > 0 ? (
              <p className="text-muted text-xs">
                No vector for {analogyResult.missing.join(', ')} — pick words from the plot.
              </p>
            ) : (
              <ol className="space-y-1">
                {analogyResult?.neighbours.map((neighbour, index) => (
                  <li key={neighbour.word} className="readout flex justify-between text-sm">
                    <span className={index === 0 ? 'font-semibold' : 'text-muted'}>
                      {neighbour.word}
                    </span>
                    <span className="text-muted">{neighbour.similarity.toFixed(3)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <p className="text-muted mt-2 text-xs leading-5">
            a, b and c are excluded from the candidates. Without that exclusion the answer is very
            often just a again.
          </p>
        </Panel>

        {targetWord && (
          <Panel className="p-4">
            <Eyebrow>Nearest to “{targetWord}”</Eyebrow>
            <p className="text-muted mt-1 text-xs leading-5">
              Pick the nearest one to answer the task.
            </p>
            <ul className="mt-2 space-y-1" data-testid="neighbour-list">
              {targetNeighbours.map((neighbour) => (
                <li key={neighbour.word}>
                  <button
                    type="button"
                    data-testid={`neighbour-${neighbour.word}`}
                    aria-pressed={answer.word === neighbour.word}
                    onClick={() => onAnswerChange({ word: neighbour.word })}
                    className={`readout flex w-full items-baseline justify-between rounded-md border px-2 py-1 text-sm ${
                      answer.word === neighbour.word
                        ? 'border-ink bg-ink text-paper'
                        : 'border-rule hover:bg-sunk'
                    }`}
                  >
                    <span>{neighbour.word}</span>
                    <span className={answer.word === neighbour.word ? '' : 'text-muted'}>
                      {neighbour.similarity.toFixed(3)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}
