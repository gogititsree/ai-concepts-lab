import { beforeEach, describe, expect, it } from 'vitest';

import { useMlpStore } from '../src/features/exercises/mlp/useMlpStore';

/**
 * The Module 2 store, driven directly.
 *
 * `test/exerciseMount.test.tsx` already mounts `MlpExercise` and clicks the buttons, which
 * is the right test for the page. It leaves two of the store's actions unreached, and both
 * are ones whose source carries a comment explaining a decision that nothing checks:
 * `advanceAnimation` deliberately *returns* instead of calling `set` once the animation has
 * finished, and `reset` is the only action that throws the learner's training away.
 *
 * A store is plain functions over plain data, so these do not need a DOM. Testing them
 * through a rendered component would mean asserting on an SVG to find out whether a counter
 * stopped incrementing.
 */

const reseed = () => useMlpStore.getState().reset(42);
const state = () => useMlpStore.getState();

beforeEach(() => {
  // The store is a module singleton shared by every test in the process; `reset(42)` puts
  // it back to exactly the state the module was constructed in.
  reseed();
});

describe('advanceAnimation', () => {
  it('walks forward one layer per tick and then goes quiet', () => {
    state().forwardOne();
    expect(state().phase).toBe('forward');
    expect(state().animationLayer).toBe(0);

    const layerCount = state().mlp.layers.length;
    for (let i = 0; i < layerCount; i += 1) state().advanceAnimation();
    expect(state().animationLayer).toBe(layerCount);

    // Past the last layer the action must not call `set` at all: zustand notifies every
    // subscriber on any `set`, changed or not, so a no-op write here would re-render the
    // whole playground once per animation frame for as long as the phase lasts. Object
    // identity is the only way to see the difference, which is why it is asserted.
    const before = state();
    state().advanceAnimation();
    expect(state()).toBe(before);
  });

  it('walks backward from the output layer and stops at -1', () => {
    state().forwardOne();
    state().backwardOne();
    expect(state().phase).toBe('backward');
    expect(state().animationLayer).toBe(state().mlp.layers.length - 1);

    for (let i = 0; i < state().mlp.layers.length + 1; i += 1) state().advanceAnimation();
    expect(state().animationLayer).toBe(-1);

    const before = state();
    state().advanceAnimation();
    expect(state()).toBe(before);
  });

  it('does nothing at all while idle', () => {
    expect(state().phase).toBe('idle');
    const before = state();
    state().advanceAnimation();
    expect(state()).toBe(before);
  });
});

describe('reset', () => {
  it('throws the training away and rebuilds the same network for the same seed', () => {
    state().trainEpoch();
    state().trainEpoch();
    state().forwardOne();
    expect(state().epochs).toBe(2);
    expect(state().lossHistory).toHaveLength(2);
    expect(state().forwardPass).not.toBeNull();

    const trainedLoss = state().loss;
    state().reset();

    expect(state().epochs).toBe(0);
    expect(state().lossHistory).toEqual([]);
    expect(state().singleSteps).toBe(0);
    expect(state().stepIndex).toBe(0);
    expect(state().forwardPass).toBeNull();
    expect(state().gradients).toBeNull();
    expect(state().phase).toBe('idle');
    expect(state().animationLayer).toBe(-1);
    expect(state().running).toBe(false);
    // Not merely "reset to something": the weights are the seeded initial ones again, so
    // the loss is back where it started rather than wherever training left it.
    expect(state().loss).not.toBeCloseTo(trainedLoss, 6);
    expect(state().seed).toBe(42);
  });

  it('keeps the seed when none is given and adopts a new one when there is', () => {
    const original = state().mlp.layers[0]?.weights[0]?.[0];

    state().reset();
    expect(state().mlp.layers[0]?.weights[0]?.[0]).toBe(original);

    state().reset(7);
    expect(state().seed).toBe(7);
    // A different seed is a different network and a different dataset draw. This is the
    // whole of the "same seed, same run" promise the page makes to the learner.
    expect(state().mlp.layers[0]?.weights[0]?.[0]).not.toBe(original);
    expect(state().points).toHaveLength(state().dataset.length);
  });

  it('keeps the dataset, hidden size and activation the learner chose', () => {
    state().setDataset('moons');
    state().setHiddenSize(6);
    state().setActivation('relu');
    state().trainEpoch();

    state().reset();

    expect(state().datasetKind).toBe('moons');
    expect(state().hiddenSize).toBe(6);
    expect(state().activation).toBe('relu');
    expect(state().mlp.layerSizes).toEqual([2, 6, 1]);
    expect(state().epochs).toBe(0);
  });
});
