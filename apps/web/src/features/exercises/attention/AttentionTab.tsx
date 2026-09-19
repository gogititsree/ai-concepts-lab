import { scaledDotProductAttention } from '@lab/nn-core';
import type { AttentionConfig } from '@lab/shared';
import { useMemo, useState } from 'react';

import { Button, Eyebrow, Panel, Readout, Slider } from '../../../components/ui';
import { AttentionArcs } from './AttentionArcs';
import { AttentionHeatmap } from './AttentionHeatmap';
import type { AttentionAnswer } from './checks';

/**
 * Tab 3: the hand-authored example from Lesson 3.3, computed live.
 *
 * Every number on this screen comes from `scaledDotProductAttention` in `nn-core` — the
 * same function the lesson's table was generated from and the same one
 * `test/attention.test.ts` proves sums to 1. Nothing is hard-coded here, which is the
 * whole reason the lesson and the tab cannot drift: change a vector in `exercises.json`
 * and both the tab and the lesson's claim about it are wrong together, visibly.
 *
 * The edit-vectors mode only edits **K**, and that is a teaching decision rather than a
 * limitation. Editing a key changes one column of scores and every row re-normalises,
 * which is the non-local behaviour worth feeling. Editing Q changes one row and is much
 * less surprising; editing V changes the output without touching a single weight, which
 * is a different lesson.
 */

export interface AttentionTabProps {
  config: AttentionConfig;
  answer: AttentionAnswer;
  onAnswerChange: (answer: AttentionAnswer) => void;
  /** The row the `attention-row` task asks about. */
  taskQueryIndex?: number;
}

export function AttentionTab({
  config,
  answer,
  onAnswerChange,
  taskQueryIndex,
}: AttentionTabProps) {
  const [scale, setScale] = useState(config.defaultScale);
  const [temperature, setTemperature] = useState(config.defaultTemperature);
  const [keys, setKeys] = useState<number[][]>(() => config.K.map((row) => [...row]));
  const [editing, setEditing] = useState(false);
  const [activeQuery, setActiveQuery] = useState<number | null>(taskQueryIndex ?? null);

  const result = useMemo(
    () => scaledDotProductAttention(config.Q, keys, config.V, { scale, temperature }),
    [config.Q, config.V, keys, scale, temperature],
  );

  const shownQuery = activeQuery ?? taskQueryIndex ?? config.words.length - 1;
  const row = result.weights[shownQuery] ?? [];
  const rowSum = row.reduce((total, value) => total + value, 0);
  const edited = keys.some((rowK, i) => rowK.some((value, j) => value !== config.K[i]?.[j]));

  return (
    <div className="space-y-5">
      <Panel className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Eyebrow>
            softmax(QKᵀ{scale ? ` / √${config.dk}` : ''}
            {temperature === 1 ? '' : ` / ${temperature}`}) · V
          </Eyebrow>
          <span className="readout text-muted text-xs">
            {config.words.length} × {config.words.length} · d_k = {config.dk}
          </span>
        </div>
        <p className="text-muted mt-1 mb-3 text-xs leading-5">
          Hover or tab through the cells: each one reads out its query word, its key word and its
          weight. Rows sum to 1 — the row you are on sums to{' '}
          <span className="readout">{rowSum.toFixed(6)}</span>.
        </p>
        <AttentionHeatmap
          words={config.words}
          weights={result.weights}
          activeQuery={activeQuery}
          onActiveQueryChange={setActiveQuery}
          selectedKey={answer.keyIndex}
          onSelectKey={(index) => onAnswerChange({ keyIndex: index })}
        />
      </Panel>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Panel className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Eyebrow>What “{config.words[shownQuery]}” looks at</Eyebrow>
            <span className="readout text-muted text-xs">row {shownQuery + 1}</span>
          </div>
          <div className="mt-2">
            <AttentionArcs words={config.words} row={row} queryIndex={shownQuery} />
          </div>
          {taskQueryIndex !== undefined && (
            <div className="border-rule mt-3 border-t pt-3">
              <Eyebrow>Which word does “{config.words[taskQueryIndex]}” attend to most?</Eyebrow>
              <div
                className="mt-2 flex flex-wrap gap-1.5"
                role="radiogroup"
                aria-label={`Which word does ${config.words[taskQueryIndex]} attend to most?`}
              >
                {config.words.map((word, index) => (
                  <Button
                    key={`answer-${index}`}
                    role="radio"
                    aria-checked={answer.keyIndex === index}
                    aria-label={`${word}, position ${index + 1}`}
                    variant={answer.keyIndex === index ? 'primary' : 'secondary'}
                    onClick={() => onAnswerChange({ keyIndex: index })}
                  >
                    {word}
                    <span className="text-[0.65rem] opacity-60">{index + 1}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <div className="space-y-5">
          <Panel className="space-y-4 p-4">
            <div>
              <Eyebrow>Scaling</Eyebrow>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant={scale ? 'primary' : 'secondary'}
                  aria-pressed={scale}
                  onClick={() => setScale(true)}
                >
                  divide by √d_k
                </Button>
                <Button
                  variant={scale ? 'secondary' : 'primary'}
                  aria-pressed={!scale}
                  onClick={() => setScale(false)}
                >
                  raw scores
                </Button>
              </div>
              <p className="text-muted mt-2 text-xs leading-5">
                Turn it off and the largest weight in this row goes to{' '}
                <span className="readout">{Math.max(...row).toFixed(3)}</span>. Bigger dot products
                push the softmax towards one-hot, and the gradient through a saturated softmax is
                nearly zero.
              </p>
            </div>

            <Slider
              label="Softmax temperature"
              min={0.2}
              max={3}
              step={0.1}
              value={temperature}
              onChange={setTemperature}
              format={(value) => value.toFixed(1)}
            />
            <p className="text-muted text-xs leading-5">
              Below 1 sharpens the row, above 1 flattens it towards uniform. It changes the weights
              and never the scores — the same lever as sampling temperature, one layer earlier.
            </p>

            <div className="grid grid-cols-2 gap-4">
              <Readout label="Row sum" value={rowSum.toFixed(6)} />
              <Readout label="Largest weight" value={Math.max(...row).toFixed(3)} />
            </div>
          </Panel>

          <Panel className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Eyebrow>Edit a key vector</Eyebrow>
              <div className="flex gap-1.5">
                <Button
                  variant={editing ? 'primary' : 'secondary'}
                  aria-pressed={editing}
                  onClick={() => setEditing((value) => !value)}
                >
                  {editing ? 'Done' : 'Edit vectors'}
                </Button>
                {edited && (
                  <Button variant="ghost" onClick={() => setKeys(config.K.map((r) => [...r]))}>
                    Reset
                  </Button>
                )}
              </div>
            </div>
            {editing ? (
              <div className="mt-3 space-y-1.5" data-testid="key-editor">
                {keys.map((vector, i) => (
                  <div key={`k-${i}`} className="flex items-center gap-2">
                    <span className="readout text-muted w-16 shrink-0 truncate text-xs">
                      {config.words[i]}
                    </span>
                    {vector.map((value, j) => (
                      <input
                        key={`k-${i}-${j}`}
                        type="number"
                        step={0.1}
                        value={value}
                        aria-label={`key vector for ${config.words[i]} position ${i + 1}, ${config.dimensionLabels?.[j] ?? `dimension ${j + 1}`}`}
                        className="border-rule bg-surface readout w-full min-w-0 rounded border px-1 py-0.5 text-xs"
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          setKeys((current) =>
                            current.map((r, ri) =>
                              ri === i ? r.map((c, ci) => (ci === j ? next : c)) : r,
                            ),
                          );
                        }}
                      />
                    ))}
                  </div>
                ))}
                {config.dimensionLabels && (
                  <p className="text-muted pt-1 text-xs">
                    columns: {config.dimensionLabels.join(' · ')}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-muted mt-2 text-xs leading-5">
                Change one key and watch its whole column move — and every other row with it.
                Attention has no local edits: the rows share a denominator.
              </p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
