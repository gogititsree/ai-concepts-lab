/**
 * The same row of weights as a picture: arcs from the query word to every key, with
 * opacity proportional to the weight.
 *
 * The heatmap answers "what is the whole matrix doing?"; this answers "what is *this*
 * word looking at?" — the question a learner actually asks, and the one the sentence
 * layout makes readable. Arc height grows with the distance spanned, so a long-range
 * dependency (`it` reaching back to `mat`) arches over the short ones instead of
 * disappearing under them.
 *
 * Opacity, not stroke width, carries the weight: a fat stroke on an arc bleeds into its
 * neighbours and starts reading as area. Width is a constant, and the weakest arcs are
 * clamped to a visible minimum so "attends a little" and "is not drawn" stay distinct.
 */

export interface AttentionArcsProps {
  words: readonly string[];
  /** Weights for the single query row being shown. */
  row: readonly number[];
  queryIndex: number;
}

const HEIGHT = 120;
const BASELINE = HEIGHT - 26;
const MIN_OPACITY = 0.08;

export function AttentionArcs({ words, row, queryIndex }: AttentionArcsProps) {
  const width = Math.max(320, words.length * 62);
  const step = width / (words.length + 1);
  const x = (index: number) => step * (index + 1);
  const max = Math.max(...row, 0.0001);

  return (
    <div className="overflow-x-auto" data-testid="attention-arcs">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Arcs from ${words[queryIndex]} to every word, thicker where the attention weight is larger. The heatmap above carries the same numbers as text.`}
      >
        {row.map((weight, k) => {
          if (k === queryIndex) return null;
          const from = x(queryIndex);
          const to = x(k);
          const span = Math.abs(to - from);
          const lift = Math.min(BASELINE - 8, 18 + span * 0.35);
          return (
            <path
              key={`arc-${k}`}
              data-testid="attention-arc"
              data-key={k}
              d={`M ${from} ${BASELINE} Q ${(from + to) / 2} ${BASELINE - lift} ${to} ${BASELINE}`}
              fill="none"
              stroke="var(--ink)"
              strokeWidth={2}
              strokeLinecap="round"
              opacity={MIN_OPACITY + (weight / max) * (1 - MIN_OPACITY)}
            />
          );
        })}

        {words.map((word, index) => (
          <g key={`word-${index}`}>
            <circle
              cx={x(index)}
              cy={BASELINE}
              r={index === queryIndex ? 4 : 2.5}
              fill="var(--ink)"
              opacity={index === queryIndex ? 1 : 0.5}
            />
            <text
              x={x(index)}
              y={BASELINE + 16}
              textAnchor="middle"
              fontSize={11}
              fill="var(--ink)"
              fontWeight={index === queryIndex ? 600 : 400}
            >
              {word}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
