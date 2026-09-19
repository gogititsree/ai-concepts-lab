import {
  clonePerceptron,
  createPerceptron,
  createRng,
  makeDataset,
  perceptronAccuracy,
  perceptronPredict,
  perceptronTrainStep,
  type DatasetKind,
  type Perceptron,
  type Point2D,
} from '@lab/nn-core';
import { create } from 'zustand';

/**
 * Playground state for Module 1.
 *
 * Zustand rather than `useState` for the reason docs/01-architecture.md gives: the animation
 * loop mutates this 60 times a second, and only the components that read a given slice should
 * re-render. Every number in here is produced by `@lab/nn-core` -- this file orchestrates and
 * stores, it does not do arithmetic the package already tests.
 */

export interface EpochRecord {
  epoch: number;
  accuracy: number;
  misclassified: number;
}

export interface PerceptronState {
  datasetKind: DatasetKind;
  points: Point2D[];
  perceptron: Perceptron;
  lr: number;
  running: boolean;
  /** Epochs run **on the current dataset**: switching datasets resets the count, which is
   *  what makes the `try-xor` check mean "twenty epochs of XOR". */
  epochs: number;
  /** Single-example steps, for the step-through task and the "what just happened" readout. */
  steps: number;
  /** Index of the next example `stepOnce` will show. */
  cursor: number;
  accuracy: number;
  history: EpochRecord[];
  selectedClass: 0 | 1;
  seed: number;
  /** The example the last single step looked at, so the canvas can ring it. */
  lastTouched: number | null;

  setDataset: (kind: DatasetKind) => void;
  setLr: (lr: number) => void;
  setSelectedClass: (label: 0 | 1) => void;
  setWeights: (weights: { w1?: number; w2?: number; b?: number }) => void;
  addPoint: (x1: number, x2: number) => void;
  movePoint: (index: number, x1: number, x2: number) => void;
  stepOnce: () => void;
  runEpoch: () => void;
  setRunning: (running: boolean) => void;
  reset: () => void;
}

const DEFAULT_DATASET: DatasetKind = 'blobs';
const DEFAULT_LR = 0.1;
const DEFAULT_SEED = 42;

function freshPerceptron(seed: number): Perceptron {
  return createPerceptron(2, createRng(seed));
}

function datasetFor(kind: DatasetKind, seed: number): Point2D[] {
  return makeDataset(kind, { seed });
}

/** Everything that must be recomputed whenever the points or the weights move. */
function measured(perceptron: Perceptron, points: Point2D[]) {
  return { accuracy: perceptronAccuracy(perceptron, points) };
}

export const usePerceptronStore = create<PerceptronState>((set, get) => ({
  datasetKind: DEFAULT_DATASET,
  points: datasetFor(DEFAULT_DATASET, DEFAULT_SEED),
  perceptron: freshPerceptron(DEFAULT_SEED),
  lr: DEFAULT_LR,
  running: false,
  epochs: 0,
  steps: 0,
  cursor: 0,
  accuracy: perceptronAccuracy(
    freshPerceptron(DEFAULT_SEED),
    datasetFor(DEFAULT_DATASET, DEFAULT_SEED),
  ),
  history: [],
  selectedClass: 1,
  seed: DEFAULT_SEED,
  lastTouched: null,

  setDataset: (kind) => {
    const { seed } = get();
    const points = datasetFor(kind, seed);
    const perceptron = freshPerceptron(seed);
    set({
      datasetKind: kind,
      points,
      perceptron,
      epochs: 0,
      steps: 0,
      cursor: 0,
      history: [],
      running: false,
      lastTouched: null,
      ...measured(perceptron, points),
    });
  },

  setLr: (lr) => set({ lr }),
  setSelectedClass: (selectedClass) => set({ selectedClass }),

  setWeights: ({ w1, w2, b }) => {
    const { perceptron, points } = get();
    const next = clonePerceptron(perceptron);
    if (w1 !== undefined) next.weights[0] = w1;
    if (w2 !== undefined) next.weights[1] = w2;
    if (b !== undefined) next.bias = b;
    set({ perceptron: next, ...measured(next, points) });
  },

  addPoint: (x1, x2) => {
    const { points, selectedClass, perceptron } = get();
    const next = [...points, { x: [x1, x2] as [number, number], y: selectedClass }];
    set({ points: next, ...measured(perceptron, next) });
  },

  movePoint: (index, x1, x2) => {
    const { points, perceptron } = get();
    const point = points[index];
    if (!point) return;
    const next = [...points];
    next[index] = { x: [x1, x2], y: point.y };
    set({ points: next, ...measured(perceptron, next) });
  },

  /**
   * One example, one update -- the unit the lesson describes. The perceptron is cloned first
   * so React sees a new object; `perceptronTrainStep` mutates in place by design.
   */
  stepOnce: () => {
    const { perceptron, points, cursor, lr, steps } = get();
    const sample = points[cursor % Math.max(1, points.length)];
    if (!sample) return;
    const next = clonePerceptron(perceptron);
    perceptronTrainStep(next, sample.x, sample.y, lr);
    set({
      perceptron: next,
      cursor: (cursor + 1) % points.length,
      steps: steps + 1,
      lastTouched: cursor % points.length,
      ...measured(next, points),
    });
  },

  runEpoch: () => {
    const { perceptron, points, lr, epochs, history } = get();
    if (points.length === 0) return;
    const next = clonePerceptron(perceptron);
    // Inlined rather than calling `perceptronTrainEpoch` so the canvas can report *which*
    // examples were wrong this pass; the arithmetic is still nn-core's.
    let misclassified = 0;
    for (const sample of points) {
      if (perceptronPredict(next, sample.x) !== sample.y) misclassified += 1;
      perceptronTrainStep(next, sample.x, sample.y, lr);
    }
    const accuracy = perceptronAccuracy(next, points);
    set({
      perceptron: next,
      epochs: epochs + 1,
      cursor: 0,
      accuracy,
      lastTouched: null,
      history: [...history, { epoch: epochs + 1, accuracy, misclassified }].slice(-200),
    });
  },

  setRunning: (running) => set({ running }),

  reset: () => {
    const { datasetKind, seed } = get();
    const points = datasetFor(datasetKind, seed);
    const perceptron = freshPerceptron(seed);
    set({
      points,
      perceptron,
      epochs: 0,
      steps: 0,
      cursor: 0,
      history: [],
      running: false,
      lastTouched: null,
      ...measured(perceptron, points),
    });
  },
}));
