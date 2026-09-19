import {
  applyGradients,
  backward,
  cloneMlp,
  createMlp,
  datasetLoss,
  forward,
  makeDataset,
  mlpAccuracy,
  mlpTrainEpoch,
  toMlpDataset,
  type DatasetKind,
  type ForwardPass,
  type Gradients,
  type HiddenActivationKind,
  type Mlp,
  type MlpSample,
  type Point2D,
} from '@lab/nn-core';
import { create } from 'zustand';

/**
 * Playground state for Module 2.
 *
 * The network itself is plain data from `@lab/nn-core` (`{ layerSizes, layers }`), which is why
 * it can sit in a store, be cloned for React's benefit, and still be the exact object the
 * gradient-check test exercises. Nothing here computes a derivative; `backward` does.
 */

export type StepPhase = 'idle' | 'forward' | 'backward';

export interface MlpState {
  datasetKind: DatasetKind;
  points: Point2D[];
  dataset: MlpSample[];
  mlp: Mlp;
  hiddenSize: number;
  activation: HiddenActivationKind;
  lr: number;
  seed: number;
  running: boolean;
  epochs: number;
  loss: number;
  accuracy: number;
  lossHistory: number[];

  /** Single-example step-through state -- the `step-through` task counts these. */
  singleSteps: number;
  stepIndex: number;
  forwardPass: ForwardPass | null;
  gradients: Gradients | null;
  phase: StepPhase;
  /** How far the layer-by-layer animation has got: -1 before it starts. */
  animationLayer: number;

  setDataset: (kind: DatasetKind) => void;
  setHiddenSize: (size: number) => void;
  setActivation: (activation: HiddenActivationKind) => void;
  setLr: (lr: number) => void;
  setRunning: (running: boolean) => void;
  forwardOne: () => void;
  backwardOne: () => void;
  advanceAnimation: () => void;
  trainEpoch: () => void;
  reset: (seed?: number) => void;
}

const DEFAULT: {
  dataset: DatasetKind;
  hiddenSize: number;
  activation: HiddenActivationKind;
  lr: number;
  seed: number;
} = { dataset: 'xor', hiddenSize: 4, activation: 'tanh', lr: 0.5, seed: 42 };

function buildMlp(hiddenSize: number, activation: HiddenActivationKind, seed: number): Mlp {
  return createMlp({
    layerSizes: [2, hiddenSize, 1],
    hiddenActivation: activation,
    outputActivation: 'sigmoid',
    seed,
  });
}

function pointsFor(kind: DatasetKind, seed: number): Point2D[] {
  return makeDataset(kind, { seed });
}

function measure(mlp: Mlp, dataset: MlpSample[]) {
  return {
    loss: datasetLoss(mlp, dataset, 'mse'),
    accuracy: mlpAccuracy(mlp, dataset),
  };
}

const initialPoints = pointsFor(DEFAULT.dataset, DEFAULT.seed);
const initialDataset = toMlpDataset(initialPoints);
const initialMlp = buildMlp(DEFAULT.hiddenSize, DEFAULT.activation, DEFAULT.seed);

export const useMlpStore = create<MlpState>((set, get) => ({
  datasetKind: DEFAULT.dataset,
  points: initialPoints,
  dataset: initialDataset,
  mlp: initialMlp,
  hiddenSize: DEFAULT.hiddenSize,
  activation: DEFAULT.activation,
  lr: DEFAULT.lr,
  seed: DEFAULT.seed,
  running: false,
  epochs: 0,
  lossHistory: [],
  singleSteps: 0,
  stepIndex: 0,
  forwardPass: null,
  gradients: null,
  phase: 'idle',
  animationLayer: -1,
  ...measure(initialMlp, initialDataset),

  setDataset: (kind) => {
    const { hiddenSize, activation, seed } = get();
    const points = pointsFor(kind, seed);
    const dataset = toMlpDataset(points);
    const mlp = buildMlp(hiddenSize, activation, seed);
    set({
      datasetKind: kind,
      points,
      dataset,
      mlp,
      epochs: 0,
      lossHistory: [],
      running: false,
      phase: 'idle',
      forwardPass: null,
      gradients: null,
      stepIndex: 0,
      animationLayer: -1,
      ...measure(mlp, dataset),
    });
  },

  setHiddenSize: (hiddenSize) => {
    const { activation, seed, dataset } = get();
    const mlp = buildMlp(hiddenSize, activation, seed);
    set({
      hiddenSize,
      mlp,
      epochs: 0,
      lossHistory: [],
      running: false,
      phase: 'idle',
      forwardPass: null,
      gradients: null,
      animationLayer: -1,
      ...measure(mlp, dataset),
    });
  },

  setActivation: (activation) => {
    const { hiddenSize, seed, dataset } = get();
    const mlp = buildMlp(hiddenSize, activation, seed);
    set({
      activation,
      mlp,
      epochs: 0,
      lossHistory: [],
      running: false,
      phase: 'idle',
      forwardPass: null,
      gradients: null,
      animationLayer: -1,
      ...measure(mlp, dataset),
    });
  },

  setLr: (lr) => set({ lr }),
  setRunning: (running) => set({ running }),

  /**
   * Forward on one example, cached. Nothing is applied: the point of the two buttons is that a
   * learner sees the forward values before any gradient exists, exactly as the lesson tells it.
   */
  forwardOne: () => {
    const { mlp, dataset, stepIndex } = get();
    const sample = dataset[stepIndex % Math.max(1, dataset.length)];
    if (!sample) return;
    set({
      forwardPass: forward(mlp, sample.x),
      gradients: null,
      phase: 'forward',
      animationLayer: 0,
    });
  },

  /** Backward on the cached forward pass, then one gradient step. */
  backwardOne: () => {
    const { mlp, dataset, stepIndex, forwardPass, lr, singleSteps } = get();
    const sample = dataset[stepIndex % Math.max(1, dataset.length)];
    if (!sample) return;
    const cache = forwardPass ?? forward(mlp, sample.x);
    const grads = backward(mlp, cache, sample.y, 'mse');
    const next = cloneMlp(mlp);
    applyGradients(next, grads, lr);
    set({
      mlp: next,
      forwardPass: cache,
      gradients: grads,
      phase: 'backward',
      animationLayer: next.layers.length - 1,
      singleSteps: singleSteps + 1,
      stepIndex: (stepIndex + 1) % Math.max(1, dataset.length),
      ...measure(next, get().dataset),
    });
  },

  /** One tick of the layer-by-layer animation; the direction depends on the phase. */
  advanceAnimation: () => {
    const { phase, animationLayer, mlp } = get();
    // Each branch returns rather than re-setting the same value: a zustand `set` notifies
    // subscribers whether or not anything changed, and a finished animation must go quiet.
    if (phase === 'forward') {
      if (animationLayer >= mlp.layers.length) return;
      set({ animationLayer: animationLayer + 1 });
    } else if (phase === 'backward') {
      if (animationLayer <= -1) return;
      set({ animationLayer: animationLayer - 1 });
    }
  },

  trainEpoch: () => {
    const { mlp, dataset, lr, epochs, lossHistory } = get();
    if (dataset.length === 0) return;
    const next = cloneMlp(mlp);
    mlpTrainEpoch(next, dataset, lr, { loss: 'mse' });
    const measured = measure(next, dataset);
    set({
      mlp: next,
      epochs: epochs + 1,
      // A fixed window keeps the chart cheap and readable; the earliest epochs stop mattering
      // once the curve has a shape.
      lossHistory: [...lossHistory, measured.loss].slice(-600),
      forwardPass: null,
      gradients: null,
      phase: 'idle',
      animationLayer: -1,
      ...measured,
    });
  },

  reset: (seed) => {
    const { datasetKind, hiddenSize, activation, seed: currentSeed } = get();
    const nextSeed = seed ?? currentSeed;
    const points = pointsFor(datasetKind, nextSeed);
    const dataset = toMlpDataset(points);
    const mlp = buildMlp(hiddenSize, activation, nextSeed);
    set({
      seed: nextSeed,
      points,
      dataset,
      mlp,
      epochs: 0,
      lossHistory: [],
      running: false,
      singleSteps: 0,
      stepIndex: 0,
      forwardPass: null,
      gradients: null,
      phase: 'idle',
      animationLayer: -1,
      ...measure(mlp, dataset),
    });
  },
}));
