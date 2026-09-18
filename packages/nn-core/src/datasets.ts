/**
 * Seeded 2-D toy datasets.
 *
 * Every generator returns the same shape -- `{ x: [x1, x2], y: 0 | 1 }[]` -- and takes the
 * same options, so the UI can swap datasets from a dropdown and the tests can loop over all
 * of them. Points sit inside roughly [-1.6, 1.6] on both axes so one canvas viewport fits
 * them all.
 *
 * Difficulty ladder, which is the point of having six of them:
 *   diagonal, blobs      linearly separable -- a perceptron solves these
 *   xor                  the classic counter-example -- needs a hidden layer
 *   circle, moons        needs a curved boundary
 *   spiral               needs a wide or deep network and patience
 */

import { type Rng, createRng, DEFAULT_SEED } from './random.js';

export interface Point2D {
  x: [number, number];
  y: 0 | 1;
}

export interface DatasetOptions {
  /** Number of points. Each generator documents its own default. */
  n?: number;
  seed?: number;
  /** Gaussian jitter added to each coordinate; generator-specific default. */
  noise?: number;
}

export type DatasetKind =
  'blobs' | 'diagonal' | 'xor' | 'xor-noisy' | 'circle' | 'moons' | 'spiral';

export const DATASET_KINDS: readonly DatasetKind[] = [
  'blobs',
  'diagonal',
  'xor',
  'xor-noisy',
  'circle',
  'moons',
  'spiral',
];

function rngFor(options: DatasetOptions): Rng {
  return createRng(options.seed ?? DEFAULT_SEED);
}

function point(x1: number, x2: number, y: 0 | 1): Point2D {
  return { x: [x1, x2], y };
}

/**
 * Two Gaussian clouds on opposite corners. Linearly separable for the default noise, which is
 * what Module 1's `separate-blobs` task relies on.
 */
export function blobs(options: DatasetOptions = {}): Point2D[] {
  const { n = 100, noise = 0.15 } = options;
  const rng = rngFor(options);
  const centres: [number, number][] = [
    [-0.6, -0.6],
    [0.6, 0.6],
  ];
  return Array.from({ length: n }, (_, i) => {
    const label: 0 | 1 = i % 2 === 0 ? 0 : 1;
    const [cx, cy] = centres[label]!;
    return point(cx + rng.normal(0, noise), cy + rng.normal(0, noise), label);
  });
}

/**
 * Uniform points split by the line x2 = x1, with a margin band left empty so the perceptron
 * has something clean to converge to (and so "100 % accuracy" is actually attainable).
 */
export function diagonal(options: DatasetOptions = {}): Point2D[] {
  const { n = 100, noise = 0.15 } = options;
  const rng = rngFor(options);
  const margin = Math.max(noise, 0.05);
  const points: Point2D[] = [];
  while (points.length < n) {
    const x1 = rng.range(-1, 1);
    const x2 = rng.range(-1, 1);
    if (Math.abs(x2 - x1) < margin) {
      continue; // inside the margin: reject and redraw
    }
    points.push(point(x1, x2, x2 > x1 ? 1 : 0));
  }
  return points;
}

/**
 * The four corners of XOR. Exactly four points, no randomness -- this is a proof, not a
 * sample: no straight line separates {(-1,-1), (1,1)} from {(-1,1), (1,-1)}.
 */
export function xor(): Point2D[] {
  return [point(-1, -1, 0), point(-1, 1, 1), point(1, -1, 1), point(1, 1, 0)];
}

/** XOR as a cloud: `n` points scattered around the four corners, same labels. */
export function xorNoisy(options: DatasetOptions = {}): Point2D[] {
  const { n = 100, noise = 0.2 } = options;
  const rng = rngFor(options);
  const corners = xor();
  return Array.from({ length: n }, (_, i) => {
    const corner = corners[i % corners.length]!;
    return point(corner.x[0] + rng.normal(0, noise), corner.x[1] + rng.normal(0, noise), corner.y);
  });
}

/** An inner disc (class 1) inside an outer ring (class 0). The simplest non-linear dataset. */
export function circle(options: DatasetOptions = {}): Point2D[] {
  const { n = 200, noise = 0.05 } = options;
  const rng = rngFor(options);
  return Array.from({ length: n }, (_, i) => {
    const label: 0 | 1 = i % 2 === 0 ? 1 : 0;
    const radius = label === 1 ? rng.range(0, 0.45) : rng.range(0.75, 1.1);
    const angle = rng.range(0, 2 * Math.PI);
    return point(
      radius * Math.cos(angle) + rng.normal(0, noise),
      radius * Math.sin(angle) + rng.normal(0, noise),
      label,
    );
  });
}

/** Two interleaving half-circles. Nearly separable, but only by a curve. */
export function moons(options: DatasetOptions = {}): Point2D[] {
  const { n = 200, noise = 0.08 } = options;
  const rng = rngFor(options);
  return Array.from({ length: n }, (_, i) => {
    const label: 0 | 1 = i % 2 === 0 ? 0 : 1;
    const t = rng.range(0, Math.PI);
    const x1 = label === 0 ? Math.cos(t) : 1 - Math.cos(t);
    const x2 = label === 0 ? Math.sin(t) : 0.5 - Math.sin(t);
    // Shift left so the pair straddles the origin like every other dataset here.
    return point(x1 - 0.5 + rng.normal(0, noise), x2 - 0.25 + rng.normal(0, noise), label);
  });
}

/** Two Archimedean spiral arms 180 degrees apart. The hard one. */
export function spiral(options: DatasetOptions = {}): Point2D[] {
  const { n = 200, noise = 0.04 } = options;
  const rng = rngFor(options);
  const perArm = Math.ceil(n / 2);
  const points: Point2D[] = [];
  for (let i = 0; i < n; i += 1) {
    const label: 0 | 1 = i % 2 === 0 ? 0 : 1;
    const index = Math.floor(i / 2);
    const t = (index / perArm) * 3.2; // radians along the arm
    const radius = 0.15 + 0.28 * t;
    const angle = t + (label === 1 ? Math.PI : 0);
    points.push(
      point(
        radius * Math.cos(angle) + rng.normal(0, noise),
        radius * Math.sin(angle) + rng.normal(0, noise),
        label,
      ),
    );
  }
  return points;
}

/** Build a dataset by name, for config-driven UI and for looping in tests. */
export function makeDataset(kind: DatasetKind, options: DatasetOptions = {}): Point2D[] {
  switch (kind) {
    case 'blobs':
      return blobs(options);
    case 'diagonal':
      return diagonal(options);
    case 'xor':
      return xor();
    case 'xor-noisy':
      return xorNoisy(options);
    case 'circle':
      return circle(options);
    case 'moons':
      return moons(options);
    case 'spiral':
      return spiral(options);
    default:
      throw new RangeError(`makeDataset: unknown dataset ${String(kind)}`);
  }
}
