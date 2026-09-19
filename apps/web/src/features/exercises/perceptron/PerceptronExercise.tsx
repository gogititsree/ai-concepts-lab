import { DATASET_KINDS, type DatasetKind } from '@lab/nn-core';
import { useEffect, useRef, useState } from 'react';

import { Button, Eyebrow, Panel, Readout, Slider } from '../../../components/ui';
import { useAnimationLoop } from '../../../hooks/useAnimationLoop';
import { useProgress } from '../../../hooks/useProgress';
import {
  exerciseKey,
  recordExerciseTasks,
  setExerciseState,
  type ExerciseProgress,
} from '../../../lib/localProgress';
import { parseExerciseConfig } from '../../../content/static';
import type { ExerciseComponentProps } from '../registry';
import { TaskList, type TaskView } from '../TaskList';
import { evaluatePerceptronTasks } from './checks';
import { PerceptronCanvas } from './PerceptronCanvas';
import { usePerceptronStore } from './usePerceptronStore';

/** Auto-run pacing. One epoch per 90 ms reads as "training" rather than as a seizure. */
const EPOCH_INTERVAL_MS = 90;

export function PerceptronExercise({ module, exercise }: ExerciseComponentProps) {
  const config = parseExerciseConfig('perceptron', exercise.config);
  const progress = useProgress();
  const stored: ExerciseProgress | undefined =
    progress.exercises[exerciseKey(module.slug, exercise.slug)];

  const state = usePerceptronStore();
  const elapsed = useRef(0);

  // The learning rate the content file chose, applied once on first mount.
  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    state.setLr(config.defaultLr);
    if (config.datasets[0]) state.setDataset(config.datasets[0]);
    // Intentionally once: this seeds the playground from content, it does not track it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useAnimationLoop((delta) => {
    elapsed.current += delta;
    if (elapsed.current < EPOCH_INTERVAL_MS) return;
    elapsed.current = 0;
    state.runEpoch();
  }, state.running);

  // --- auto-checks ------------------------------------------------------------------
  const passing = evaluatePerceptronTasks(config, {
    dataset: state.datasetKind,
    accuracy: state.accuracy,
    epochsRun: state.epochs,
  });
  const passingKey = passing.join(',');
  const required = exercise.completionRule.type === 'tasks' ? exercise.completionRule.required : 1;

  useEffect(() => {
    if (passingKey === '') return;
    recordExerciseTasks(module.slug, exercise.slug, passingKey.split(','), required);
  }, [passingKey, module.slug, exercise.slug, required]);

  const completedIds = new Set(stored?.tasksCompleted ?? []);
  const tasks: TaskView[] = config.tasks.map((task) => ({
    id: task.id,
    label: task.label,
    hintMd: task.hintMd,
    passing: passing.includes(task.id),
    completed: completedIds.has(task.id),
  }));

  const [reflection, setReflection] = useState<string>(
    typeof stored?.state?.reflection === 'string' ? stored.state.reflection : '',
  );

  const datasets = config.datasets.filter((kind): kind is DatasetKind =>
    DATASET_KINDS.includes(kind),
  );
  const [w1 = 0, w2 = 0] = state.perceptron.weights;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-5">
        <PerceptronCanvas
          points={state.points}
          perceptron={state.perceptron}
          highlighted={state.lastTouched}
          onAddPoint={state.addPoint}
          onMovePoint={state.movePoint}
        />

        <Panel className="p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Readout
              label="Accuracy"
              value={`${(state.accuracy * 100).toFixed(1)} %`}
              hint="Fraction of the current points classified correctly"
            />
            <Readout label="Epochs" value={state.epochs} hint="Full passes over this dataset" />
            <Readout label="Steps" value={state.steps} hint="Single-example updates" />
            <Readout label="Points" value={state.points.length} />
          </div>
        </Panel>

        <Panel className="space-y-4 p-4">
          <div>
            <Eyebrow>Dataset</Eyebrow>
            <div className="mt-2 flex flex-wrap gap-2">
              {datasets.map((kind) => (
                <Button
                  key={kind}
                  variant={state.datasetKind === kind ? 'primary' : 'secondary'}
                  aria-pressed={state.datasetKind === kind}
                  onClick={() => state.setDataset(kind)}
                >
                  {kind}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Eyebrow>Click adds a point of class</Eyebrow>
              <div className="mt-2 flex gap-2">
                {([1, 0] as const).map((label) => (
                  <Button
                    key={label}
                    variant={state.selectedClass === label ? 'primary' : 'secondary'}
                    aria-pressed={state.selectedClass === label}
                    onClick={() => state.setSelectedClass(label)}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: label === 1 ? 'var(--pos)' : 'var(--neg)' }}
                    />
                    class {label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="min-w-40 flex-1">
              <Slider
                label="Learning rate"
                min={0.01}
                max={1}
                step={0.01}
                value={state.lr}
                onChange={state.setLr}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={state.stepOnce} disabled={state.running}>
              Step one example
            </Button>
            <Button onClick={state.runEpoch} disabled={state.running}>
              Run one epoch
            </Button>
            <Button
              variant={state.running ? 'primary' : 'secondary'}
              aria-pressed={state.running}
              onClick={() => state.setRunning(!state.running)}
            >
              {state.running ? 'Stop' : 'Auto-run'}
            </Button>
            <Button variant="ghost" onClick={state.reset}>
              Reset
            </Button>
          </div>
        </Panel>
      </div>

      <div className="space-y-5">
        <Panel className="space-y-3 p-4">
          <Eyebrow>Weights (drag to steer the line by hand)</Eyebrow>
          <Slider
            label="w1"
            min={-3}
            max={3}
            step={0.01}
            value={w1}
            onChange={(value) => state.setWeights({ w1: value })}
          />
          <Slider
            label="w2"
            min={-3}
            max={3}
            step={0.01}
            value={w2}
            onChange={(value) => state.setWeights({ w2: value })}
          />
          <Slider
            label="b"
            min={-3}
            max={3}
            step={0.01}
            value={state.perceptron.bias}
            onChange={(value) => state.setWeights({ b: value })}
          />
          <p className="text-muted text-xs leading-5">
            The arrow on the canvas is this vector. It stays perpendicular to the line, which is the
            whole geometric story of Lesson 1.
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
