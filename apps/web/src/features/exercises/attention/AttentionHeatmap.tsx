import { sequentialColor } from '../../../lib/colorScale';

/**
 * The attention matrix: rows are queries, columns are keys, colour is the weight.
 *
 * The **sequential** scale from `lib/colorScale.ts`, not the diverging one: a softmax
 * weight is in [0, 1] and has no sign, and the amber ramp is monotonic in lightness so
 * the darker cell is always the larger number even in greyscale or with any form of
 * colour blindness. The scale is normalised to the largest weight in the matrix rather
 * than to 1, because a flat row at 0.12 would otherwise be eight identical near-white
 * squares and the whole point is the contrast between rows.
 *
 * **Keyboard and screen reader.** Each cell is a focusable button with an `aria-label`
 * naming the query word, the key word and the weight — so "what does `it` attend to?" is
 * answerable by tabbing, not only by hovering. The grid is a real `<table>` with row and
 * column headers underneath the visual layer, and a `<caption>` carrying the argmax of
 * every row in prose. A heatmap that can only be read with a mouse is a picture of data,
 * not data.
 */

export interface AttentionHeatmapProps {
  words: readonly string[];
  weights: readonly (readonly number[])[];
  /** The row currently emphasised (hover or focus), or null. */
  activeQuery: number | null;
  onActiveQueryChange: (index: number | null) => void;
  /** The key the learner has picked as the answer, highlighted with a ring. */
  selectedKey?: number | null;
  onSelectKey?: (index: number) => void;
}

const argMax = (row: readonly number[]): number =>
  row.reduce((best, value, index) => (value > (row[best] ?? -Infinity) ? index : best), 0);

export function AttentionHeatmap({
  words,
  weights,
  activeQuery,
  onActiveQueryChange,
  selectedKey = null,
  onSelectKey,
}: AttentionHeatmapProps) {
  const max = Math.max(...weights.flatMap((row) => [...row]), 0.0001);

  // Two words in the sample sentence are "the", so every label says which position it is.
  const label = (index: number) => `${words[index]} (${index + 1})`;

  const summary = weights
    .map((row, index) => `${label(index)} attends most to ${label(argMax(row))}`)
    .join('; ');

  return (
    <div className="overflow-x-auto" data-testid="attention-heatmap">
      <table className="border-separate border-spacing-0.5 text-xs">
        <caption className="text-muted mb-2 text-left text-xs leading-5">
          Attention weights, rows are queries and columns are keys; every row sums to 1.{' '}
          <span data-testid="heatmap-summary">{summary}.</span>
        </caption>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              query
            </th>
            {words.map((word, index) => (
              <th
                key={`head-${index}`}
                scope="col"
                className="readout text-muted max-w-14 truncate px-1 pb-1 align-bottom font-normal"
              >
                {word}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weights.map((row, q) => (
            <tr key={`row-${q}`} data-testid="heatmap-row">
              <th
                scope="row"
                className={`readout px-1 py-0.5 text-right font-normal ${
                  activeQuery === q ? 'text-ink font-semibold' : 'text-muted'
                }`}
              >
                {words[q]}
              </th>
              {row.map((weight, k) => (
                <td key={`cell-${q}-${k}`} className="p-0">
                  <button
                    type="button"
                    data-testid="heatmap-cell"
                    data-query={q}
                    data-key={k}
                    aria-label={`${label(q)} attends to ${label(k)} with weight ${weight.toFixed(3)}`}
                    title={`${words[q]} → ${words[k]}: ${weight.toFixed(3)}`}
                    onMouseEnter={() => onActiveQueryChange(q)}
                    onMouseLeave={() => onActiveQueryChange(null)}
                    onFocus={() => onActiveQueryChange(q)}
                    onBlur={() => onActiveQueryChange(null)}
                    onClick={() => onSelectKey?.(k)}
                    className={`flex h-8 w-8 items-center justify-center rounded-[3px] text-[10px] transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:outline-none sm:h-9 sm:w-9 ${
                      activeQuery === null || activeQuery === q ? 'opacity-100' : 'opacity-35'
                    } ${selectedKey === k && activeQuery === q ? 'ring-2 ring-[var(--ink)]' : ''}`}
                    style={{ backgroundColor: sequentialColor(weight, 0, max) }}
                  >
                    {/* The number, not just the colour. Colour alone is never the data. */}
                    <span
                      className={weight > max * 0.6 ? 'text-[var(--paper)]' : 'text-[var(--ink)]'}
                    >
                      {weight.toFixed(2).slice(1)}
                    </span>
                  </button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
