/**
 * The PCA scatter: 42 words on two axes that between them keep about 15 % of the
 * variance. SVG rather than Canvas, because every point needs hover, focus, a click
 * target and a label — Canvas would mean re-implementing all four.
 *
 * Accessibility is not an afterthought here, it is most of the component. A scatter plot
 * is the least screen-reader-friendly thing in the app, so:
 *  - every point is a `<button>` inside the SVG's foreign-object-free world (an SVG
 *    element with `role="button"` and `tabIndex`), reachable by Tab and activated by
 *    Enter or Space,
 *  - each carries an `aria-label` with the word, its cluster and its coordinates, and
 *  - the whole plot is followed by a plain text list of the words, grouped by cluster,
 *    which is the actual text alternative. It is visible: a legend that only exists for
 *    assistive technology tends to rot.
 */

export interface ScatterPoint {
  word: string;
  cluster: string;
  x: number;
  y: number;
}

export interface EmbeddingScatterProps {
  points: readonly ScatterPoint[];
  selected: readonly string[];
  onToggle: (word: string) => void;
  /** Words to draw emphasised — the analogy's inputs and its answer. */
  highlighted?: readonly string[];
}

const WIDTH = 520;
const HEIGHT = 380;
const PAD = 26;

/**
 * Cluster colours. Same reasoning as the token chips: a cluster is a *label*, not a
 * magnitude, so it gets a hue cycle rather than one of the two ordered scales in
 * `lib/colorScale.ts`. Shape does the work for anyone who cannot see hue — selected
 * points get a ring and highlighted ones get a larger radius, neither of which is colour.
 */
function clusterColor(clusters: readonly string[], cluster: string): string {
  const index = Math.max(0, clusters.indexOf(cluster));
  return `oklch(0.62 0.13 ${(index * 360) / Math.max(1, clusters.length)})`;
}

export function EmbeddingScatter({
  points,
  selected,
  onToggle,
  highlighted = [],
}: EmbeddingScatterProps) {
  const clusters = [...new Set(points.map((point) => point.cluster))];

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 0);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 0);
  // A zero-width axis (one point, or no variance) would divide by zero; 1 keeps it centred.
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const toX = (x: number) => PAD + ((x - minX) / spanX) * (WIDTH - 2 * PAD);
  // SVG y grows downwards; flipping keeps "up" meaning "more".
  const toY = (y: number) => HEIGHT - PAD - ((y - minY) / spanY) * (HEIGHT - 2 * PAD);

  return (
    <div data-testid="embedding-scatter">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="group"
        aria-label={`Scatter plot of ${points.length} words projected to two dimensions by PCA. The word list below carries the same information as text.`}
      >
        <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="var(--sunk)" rx={6} />
        <line
          x1={toX(0)}
          y1={PAD / 2}
          x2={toX(0)}
          y2={HEIGHT - PAD / 2}
          stroke="var(--rule)"
          strokeWidth={1}
        />
        <line
          x1={PAD / 2}
          y1={toY(0)}
          x2={WIDTH - PAD / 2}
          y2={toY(0)}
          stroke="var(--rule)"
          strokeWidth={1}
        />

        {points.map((point) => {
          const isSelected = selected.includes(point.word);
          const isHighlighted = highlighted.includes(point.word);
          const cx = toX(point.x);
          const cy = toY(point.y);
          return (
            <g
              key={point.word}
              data-testid="scatter-point"
              data-word={point.word}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={`${point.word}, cluster ${point.cluster}, at ${point.x.toFixed(2)}, ${point.y.toFixed(2)}${isSelected ? ', selected' : ''}`}
              className="cursor-pointer focus:outline-none [&:focus-visible>circle]:stroke-[var(--ink)] [&:focus-visible>circle]:stroke-2"
              onClick={() => onToggle(point.word)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onToggle(point.word);
                }
              }}
            >
              <circle
                cx={cx}
                cy={cy}
                r={isSelected || isHighlighted ? 6 : 4}
                fill={clusterColor(clusters, point.cluster)}
                stroke={isSelected ? 'var(--ink)' : 'transparent'}
                strokeWidth={isSelected ? 2 : 0}
              />
              <text
                x={cx + 7}
                y={cy + 3.5}
                fontSize={10}
                fill="var(--ink)"
                fontWeight={isSelected || isHighlighted ? 600 : 400}
                pointerEvents="none"
              >
                {point.word}
              </text>
            </g>
          );
        })}
      </svg>

      <ul className="mt-3 space-y-1" data-testid="scatter-text-alternative">
        {clusters.map((cluster) => (
          <li key={cluster} className="flex flex-wrap items-baseline gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: clusterColor(clusters, cluster) }}
            />
            <span className="eyebrow">{cluster}</span>
            <span className="readout text-muted">
              {points
                .filter((point) => point.cluster === cluster)
                .map((point) => point.word)
                .join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
