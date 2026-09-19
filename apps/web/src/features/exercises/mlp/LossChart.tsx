/**
 * Loss per epoch, as a polyline.
 *
 * The lesson's whole point about instrumentation is that a single final number hides the
 * shape, so this chart is deliberately plain: linear axes, the current value called out, and
 * no smoothing that could hide an oscillation caused by too large a learning rate.
 */

const WIDTH = 460;
const HEIGHT = 150;
const PAD_LEFT = 44;
const PAD_BOTTOM = 22;
const PAD_TOP = 10;
const PAD_RIGHT = 8;

export interface LossChartProps {
  history: number[];
  /** Drawn as a dashed rule, e.g. the 0.05 the XOR task asks for. */
  target?: number;
}

/** Keeps the polyline to a few hundred points however long training ran. */
function downsample(values: number[], limit = 320): number[] {
  if (values.length <= limit) return values;
  const stride = Math.ceil(values.length / limit);
  return values.filter((_, index) => index % stride === 0 || index === values.length - 1);
}

export function LossChart({ history, target }: LossChartProps) {
  const series = downsample(history);
  const maxLoss = Math.max(0.05, ...series, target ?? 0);
  const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const x = (index: number): number =>
    PAD_LEFT + (series.length <= 1 ? innerWidth : (index / (series.length - 1)) * innerWidth);
  const y = (value: number): number => PAD_TOP + innerHeight * (1 - value / maxLoss);

  const path = series.map((value, index) => `${x(index)},${y(value)}`).join(' ');
  const latest = history[history.length - 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="bg-surface border-rule w-full rounded-lg border"
        role="img"
        aria-label="Training loss per epoch"
        data-testid="loss-chart"
      >
        <line
          x1={PAD_LEFT}
          y1={PAD_TOP}
          x2={PAD_LEFT}
          y2={HEIGHT - PAD_BOTTOM}
          stroke="var(--rule)"
        />
        <line
          x1={PAD_LEFT}
          y1={HEIGHT - PAD_BOTTOM}
          x2={WIDTH - PAD_RIGHT}
          y2={HEIGHT - PAD_BOTTOM}
          stroke="var(--rule)"
        />

        <text x={4} y={PAD_TOP + 8} fontSize="9" className="readout" fill="var(--muted)">
          {maxLoss.toFixed(3)}
        </text>
        <text x={4} y={HEIGHT - PAD_BOTTOM} fontSize="9" className="readout" fill="var(--muted)">
          0
        </text>
        <text
          x={WIDTH - PAD_RIGHT}
          y={HEIGHT - 6}
          fontSize="9"
          textAnchor="end"
          className="readout"
          fill="var(--muted)"
        >
          {history.length} epochs
        </text>

        {target !== undefined && target <= maxLoss && (
          <line
            x1={PAD_LEFT}
            y1={y(target)}
            x2={WIDTH - PAD_RIGHT}
            y2={y(target)}
            stroke="var(--muted)"
            strokeDasharray="3 3"
            opacity="0.7"
          />
        )}

        {series.length > 1 && (
          <polyline
            points={path}
            fill="none"
            stroke="var(--ink)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            data-testid="loss-line"
          />
        )}
        {series.length === 1 && <circle cx={x(0)} cy={y(series[0] ?? 0)} r="2" fill="var(--ink)" />}
      </svg>

      <p className="readout text-muted mt-2 text-xs">
        {latest === undefined
          ? 'Train an epoch to start the curve.'
          : `loss ${latest.toFixed(5)}${target !== undefined ? ` · target ${target}` : ''}`}
      </p>
    </div>
  );
}
