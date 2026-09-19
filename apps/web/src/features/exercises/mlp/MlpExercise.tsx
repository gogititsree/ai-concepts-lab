import { countParameters, type DatasetKind, type HiddenActivationKind } from '@lab/nn-core';
import { useEffect, useRef, useState } from 'react';

import { Button, Eyebrow, Panel, Readout, Slider } from '../../../components/ui';
import { parseExerciseConfig } from '../../../content/static';
import { useAnimationLoop } from '../../../hooks/useAnimationLoop';
import { useProgress } from '../../../hooks/useProgress';
import {
  exerciseKey,
  recordExerciseTasks,
  setExerciseState,
  type ExerciseProgress,
} from '../../../lib/localProgress';
import type { ExerciseComponentProps } from '../registry';
import { TaskList, type TaskView } from '../TaskList';
import { BoundaryHeatmap } from './BoundaryHeatmap';
import { bestRecord, evaluateMlpTasks, recordedValue } from './checks';
import { LossChart } from './LossChart';
import { NetworkGraph } from './NetworkGraph';
import { useMlpStore } from './useMlpStore';

/** One animation frame per ~160 ms while stepping: fast enough to feel live, slow to read. */
const ANIMATION_INTERVAL_MS = 160;

export function MlpExercise({ module, exercise }: ExerciseComponentProps) {
  const config = parseExerciseConfig('mlp', exercise.config);
  const progress = useProgress();
  const stored: ExerciseProgress | undefined =
    progress.exercises[exerciseKey(module.slug, exercise.slug)];

  const state = useMlpStore();
  const trainClock = useRef(0);
  const animationClock = useRef(0);

  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    state.setLr(config.defaultLr);
    if (config.defaultHiddenSize) state.setHiddenSize(config.defaultHiddenSize);
    if (config.datasets[0]) state.setDataset(config.datasets[0]);
    // Seeds the playground from content once; it does not track content afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-train. Epochs per frame scale with dataset size so XOR (4 points) does not crawl and
  // spiral (200+) does not drop frames.
  const epochsPerFrame = Math.max(1, Math.round(200 / Math.max(1, state.dataset.length)));
  useAnimationLoop((delta) => {
    trainClock.current += delta;
    if (trainClock.current < 16) return;
    trainClock.current = 0;
    for (let i = 0; i < epochsPerFrame; i += 1) state.trainEpoch();
  }, state.running);

  // The step-through animation walks the layers; the store decides the direction. The
  // condition has to go *false* when the walk finishes, or requestAnimationFrame keeps firing
  // (and re-rendering) forever on a finished animation.
  const animating =
    state.phase === 'forward'
      ? state.animationLayer < state.mlp.layers.length
      : state.phase === 'backward' && state.animationLayer > -1;
  useAnimationLoop((delta) => {
    animationClock.current += delta;
    if (animationClock.current < ANIMATION_INTERVAL_MS) return;
    animationClock.current = 0;
    state.advanceAnimation();
  }, animating);

  // --- auto-checks ------------------------------------------------------------------
  const measurements = {
    dataset: state.datasetKind,
    loss: state.loss,
    accuracy: state.accuracy,
    epochs: state.epochs,
    singleSteps: state.singleSteps,
    hiddenSize: state.hiddenSize,
  };
  const passing = evaluateMlpTasks(config, measurements);
  const passingKey = passing.join(',');
  const required = exercise.completionRule.type === 'tasks' ? exercise.completionRule.required : 1;

  const storedRecords = (stored?.state?.records ?? {}) as Record<string, number>;

  useEffect(() => {
    if (passingKey === '') return;
    recordExerciseTasks(module.slug, exercise.slug, passingKey.split(','), required);
  }, [passingKey, module.slug, exercise.slug, required]);

  // A `record` task keeps the smallest hidden size that ever cleared its threshold.
  const candidateRecords: Record<string, number> = {};
  for (const task of config.tasks) {
    const value = recordedValue(task, measurements);
    const best = bestRecord(storedRecords[task.id], value);
    if (best !== undefined) candidateRecords[task.id] = best;
  }
  const recordsKey = JSON.stringify(candidateRecords);
  useEffect(() => {
    const records = JSON.parse(recordsKey) as Record<string, number>;
    if (Object.keys(records).length === 0) return;
    setExerciseState(module.slug, exercise.slug, { records });
  }, [recordsKey, module.slug, exercise.slug]);

  const completedIds = new Set(stored?.tasksCompleted ?? []);
  const tasks: TaskView[] = config.tasks.map((task) => ({
    id: task.id,
    label: task.label,
    hintMd: task.hintMd,
    passing: passing.includes(task.id),
    completed: completedIds.has(task.id),
    recorded:
      task.check.record === 'hiddenSize' && candidateRecords[task.id] !== undefined
        ? `hidden size ${candidateRecords[task.id]}`
        : undefined,
  }));

  const [reflection, setReflection] = useState<string>(
    typeof stored?.state?.reflection === 'string' ? stored.state.reflection : '',
  );

  const lossTarget = config.tasks.find((task) => task.check.loss)?.check.loss;
  const targetValue = lossTarget ? Number(lossTarget.replace(/[^0-9.]/g, '')) : undefined;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Panel className="p-4">
          <div className="flex items-baseline justify-between">
            <Eyebrow>Network {state.mlp.layerSizes.join('-')}</Eyebrow>
            <span className="readout text-muted text-xs">
              {countParameters(state.mlp)} parameters
            </span>
          </div>
          <div className="mt-3">
            <NetworkGraph
              mlp={state.mlp}
              activations={state.forwardPass?.activations ?? null}
              gradients={state.gradients}
              animationLayer={state.animationLayer}
              phase={state.phase}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={state.forwardOne} disabled={state.running}>
              Forward one example
            </Button>
            <Button onClick={state.backwardOne} disabled={state.running}>
              Backward one example
            </Button>
            <span className="readout text-muted self-center text-xs">
              example #{state.stepIndex} &middot; {state.singleSteps} steps
            </span>
          </div>
        </Panel>

        <Panel className="p-4">
          <Eyebrow>Loss per epoch</Eyebrow>
          <div className="mt-3">
            <LossChart history={state.lossHistory} target={targetValue} />
          </div>
        </Panel>
      </div>

      <div className="space-y-5">
        <BoundaryHeatmap mlp={state.mlp} points={state.points} />

        <Panel className="p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Readout label="Loss" value={state.loss.toFixed(4)} hint="Mean squared error" />
            <Readout label="Accuracy" value={`${(state.accuracy * 100).toFixed(1)} %`} />
            <Readout label="Epochs" value={state.epochs} />
            <Readout label="Seed" value={state.seed} />
          </div>
        </Panel>

        <Panel className="space-y-4 p-4">
          <div>
            <Eyebrow>Dataset</Eyebrow>
            <div className="mt-2 flex flex-wrap gap-2">
              {config.datasets.map((kind) => (
                <Button
                  key={kind}
                  variant={state.datasetKind === kind ? 'primary' : 'secondary'}
                  aria-pressed={state.datasetKind === kind}
                  onClick={() => state.setDataset(kind as DatasetKind)}
                >
                  {kind}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-6">
            <div>
              <Eyebrow>Hidden units</Eyebrow>
              <div className="mt-2 flex flex-wrap gap-1">
                {config.hiddenSizes.map((size) => (
                  <Button
                    key={size}
                    className="w-9 px-0"
                    variant={state.hiddenSize === size ? 'primary' : 'secondary'}
                    aria-pressed={state.hiddenSize === size}
                    onClick={() => state.setHiddenSize(size)}
                  >
                    {size}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <Eyebrow>Hidden activation</Eyebrow>
              <div className="mt-2 flex gap-2">
                {config.activations.map((activation) => (
                  <Button
                    key={activation}
                    variant={state.activation === activation ? 'primary' : 'secondary'}
                    aria-pressed={state.activation === activation}
                    onClick={() => state.setActivation(activation as HiddenActivationKind)}
                  >
                    {activation}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <Slider
            label="Learning rate"
            min={0.01}
            max={3}
            step={0.01}
            value={state.lr}
            onChange={state.setLr}
          />

          <div className="flex flex-wrap gap-2">
            <Button onClick={state.trainEpoch} disabled={state.running}>
              Train 1 epoch
            </Button>
            <Button
              variant={state.running ? 'primary' : 'secondary'}
              aria-pressed={state.running}
              onClick={() => state.setRunning(!state.running)}
            >
              {state.running ? 'Stop' : 'Auto-train'}
            </Button>
            <Button variant="ghost" onClick={() => state.reset()}>
              Reset weights
            </Button>
            <Button variant="ghost" onClick={() => state.reset(state.seed + 1)}>
              New seed
            </Button>
          </div>
          <p className="text-muted text-xs leading-5">
            Changing the dataset, the hidden size or the activation rebuilds the network from the
            seed, so every comparison starts from the same place.
          </p>
        </Panel>

        <TaskList
          tasks={tasks}
          required={required}
          reflectionMd={config.reflectionMd}
          reflection={reflection}
          onReflectionChange={(value) => {
            setReflection(value);
            setExerciseState(module.slug, exercise.slug, { reflection: value });
          }}
        />
      </div>
    </div>
  );
}
