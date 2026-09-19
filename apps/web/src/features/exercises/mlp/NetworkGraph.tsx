import type { Gradients, Mlp } from '@lab/nn-core';
import { useState } from 'react';

import { activationRgb, divergingColor, rgbToCss } from '../../../lib/colorScale';
import type { StepPhase } from './useMlpStore';

/**
 * The network as an SVG diagram: nodes are units, edges are weights.
 *
 * SVG and not Canvas because there are at most ~40 elements and every one of them wants hover
 * semantics — pointing at an edge should tell you its weight and its last gradient. That is
 * the whole reason this visualisation exists: a weight matrix printed as numbers teaches
 * nothing, a weight matrix drawn as thickness and colour teaches the vanishing gradient in one
 * glance.
 *
 * Encoding:
 * - edge **width** is proportional to |w| (or |dL/dw| during the backward animation),
 * - edge **colour** is the diverging scale: blue negative, red positive,
 * - node **fill** is the activation, on the sequential ramp for sigmoid outputs and the
 *   diverging one for signed activations like tanh.
 */

export interface NetworkGraphProps {
  mlp: Mlp;
  /** `cache.activations` from a forward pass: `[input, ...layer outputs]`. */
  activations: number[][] | null;
  gradients: Gradients | null;
  /** Which column the step animation has reached; -1 when idle. */
  animationLayer: number;
  phase: StepPhase;
}

const WIDTH = 460;
const HEIGHT = 300;
const PADDING = 44;
const NODE_RADIUS = 13;

interface HoverInfo {
  label: string;
  weight: number;
  gradient: number | undefined;
}

function maxAbsWeight(mlp: Mlp): number {
  let max = 1e-6;
  for (const layer of mlp.layers) {
    for (const row of layer.weights) {
      for (const w of row) max = Math.max(max, Math.abs(w));
    }
  }
  return max;
}

function maxAbsGradient(gradients: Gradients | null): number {
  if (!gradients) return 1e-6;
  let max = 1e-9;
  for (const layer of gradients.dWeights) {
    for (const row of layer) {
      for (const g of row) max = Math.max(max, Math.abs(g));
    }
  }
  return max;
}

export function NetworkGraph({
  mlp,
  activations,
  gradients,
  animationLayer,
  phase,
}: NetworkGraphProps) {
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const columns = mlp.layerSizes;
  const weightScale = maxAbsWeight(mlp);
  const gradientScale = maxAbsGradient(gradients);
  const showGradients = phase === 'backward' && gradients !== null;

  const x = (column: number): number =>
    columns.length === 1
      ? WIDTH / 2
      : PADDING + (column * (WIDTH - 2 * PADDING)) / (columns.length - 1);
  const y = (index: number, count: number): number =>
    count === 1 ? HEIGHT / 2 : PADDING + (index * (HEIGHT - 2 * PADDING)) / (count - 1);

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="bg-surface border-rule w-full rounded-lg border"
        role="img"
        aria-label={`Network diagram, layer sizes ${columns.join('-')}`}
        data-testid="network-graph"
      >
        {mlp.layers.map((layer, l) =>
          layer.weights.map((row, j) =>
            row.map((weight, i) => {
              const gradient = gradients?.dWeights[l]?.[j]?.[i];
              const magnitude = showGradients
                ? Math.abs(gradient ?? 0) / gradientScale
                : Math.abs(weight) / weightScale;
              const value = showGradients ? (gradient ?? 0) : weight;
              const lit =
                animationLayer < 0 ||
                (phase === 'forward' ? l < animationLayer : l >= animationLayer);
              return (
                <line
                  key={`e-${l}-${j}-${i}`}
                  data-testid="network-edge"
                  x1={x(l)}
                  y1={y(i, columns[l] ?? 1)}
                  x2={x(l + 1)}
                  y2={y(j, columns[l + 1] ?? 1)}
                  stroke={divergingColor(value, showGradients ? gradientScale : weightScale)}
                  strokeWidth={0.6 + magnitude * 4}
                  strokeLinecap="round"
                  opacity={lit ? 0.95 : 0.25}
                  onMouseEnter={() =>
                    setHover({
                      label: `layer ${l} · unit ${j} ← input ${i}`,
                      weight,
                      gradient,
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                >
                  <title>
                    {`w = ${weight.toFixed(4)}${
                      gradient === undefined ? '' : `, dL/dw = ${gradient.toExponential(2)}`
                    }`}
                  </title>
                </line>
              );
            }),
          ),
        )}

        {columns.map((count, column) => {
          const signed =
            column === 0 || (column < columns.length - 1 && mlp.hiddenActivation !== 'sigmoid');
          return Array.from({ length: count }, (_, index) => {
            const value = activations?.[column]?.[index];
            const lit = animationLayer < 0 || column <= animationLayer;
            return (
              <g key={`n-${column}-${index}`}>
                <circle
                  data-testid="network-node"
                  cx={x(column)}
                  cy={y(index, count)}
                  r={NODE_RADIUS}
                  fill={
                    value === undefined ? 'var(--surface)' : rgbToCss(activationRgb(value, signed))
                  }
                  stroke="var(--ink)"
                  strokeWidth={lit && value !== undefined ? 1.6 : 0.8}
                  opacity={lit ? 1 : 0.45}
                >
                  <title>
                    {value === undefined
                      ? `layer ${column}, unit ${index}`
                      : `a = ${value.toFixed(4)}`}
                  </title>
                </circle>
                {value !== undefined && lit && (
                  <text
                    x={x(column)}
                    y={y(index, count) + 3.5}
                    textAnchor="middle"
                    className="readout"
                    fontSize="8"
                    fill="var(--ink)"
                  >
                    {value.toFixed(2)}
                  </text>
                )}
              </g>
            );
          });
        })}

        {['input', 'hidden', 'output'].map((label, column) =>
          column < columns.length ? (
            <text
              key={label}
              x={x(column)}
              y={HEIGHT - 12}
              textAnchor="middle"
              fontSize="9"
              className="readout"
              fill="var(--muted)"
            >
              {label}
            </text>
          ) : null,
        )}
      </svg>

      <p className="readout text-muted mt-2 h-8 text-xs leading-4" data-testid="network-hover">
        {hover ? (
          <>
            {hover.label}
            <br />
            <span className="text-ink">w = {hover.weight.toFixed(4)}</span>
            {hover.gradient !== undefined && (
              <span> · dL/dw = {hover.gradient.toExponential(2)}</span>
            )}
          </>
        ) : (
          'Hover an edge for its weight and last gradient. Width is magnitude, colour is sign.'
        )}
      </p>
    </div>
  );
}
