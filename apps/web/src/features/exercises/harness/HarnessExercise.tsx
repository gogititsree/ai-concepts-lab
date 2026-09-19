import type { HarnessCheckId, HarnessTask } from '@lab/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';

import { Button, Eyebrow, Panel, Readout } from '../../../components/ui';
import { parseExerciseConfig } from '../../content/exerciseConfig';
import { useExercisePersistence } from '../../content/useExercisePersistence';
import { AgentTrace } from '../../runs/AgentTrace';
import { useModelHealth } from '../prompt/useChatRun';
import type { ExerciseComponentProps } from '../registry';
import { TaskList, type TaskView } from '../TaskList';
import { evaluateHarnessChecks, realRunPassed } from './checks';
import { CodeEditor } from './CodeEditor';
import { useHarnessRunner, type WorkerFactory } from './useHarnessRunner';

/**
 * Module 6's exercise: write the loop, run it in a worker, watch the checks go green.
 *
 * The shape of this page comes from two measurements rather than from taste.
 *
 * **The scripted checks are instant and the real run is minutes.** So they are two
 * buttons with two completely different affordances: "Run scripted checks" gives a
 * verdict before the finger leaves the mouse, and "Run against Gemma" gets the elapsed
 * counter, the cancel button and the streaming trace that Module 5 needed for the same
 * reason (a two-call run measured 19-32 s warm and 68 s cold — docs/spike-notes.md).
 * Completion needs only the three scripted checks, so the module stays finishable on a
 * laptop with no Ollama.
 *
 * **Losing your code would be unforgivable.** The editor's contents go through
 * `useExercisePersistence`, debounced by two seconds and flushed on unmount, and are
 * restored on mount. The reset button is the only thing that throws work away, and it
 * asks first.
 */

const fmtSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Maps a config task to the check it reads. Only `scripted` tasks have one. */
const scriptedCheckOf = (task: HarnessTask): HarnessCheckId | null =>
  task.check.type === 'scripted' ? task.check.check : null;

function UnavailableBanner({ detail }: { detail?: string }) {
  return (
    <Panel className="border-ink/30 bg-sunk p-4" data-testid="model-unavailable-banner">
      <Eyebrow>No model attached</Eyebrow>
      <p className="mt-1 text-sm leading-6">
        The optional <strong>real run</strong> needs a language model and none is reachable from
        here. The deployed copy of this app runs with <code>MODEL_PROVIDER=none</code> on purpose:
        the free tier has no GPU. <strong>The three scripted checks still work</strong> — they run
        entirely in your browser against a deterministic fake, which is exactly why they exist.
        Clone the repo and start Ollama (<code>ollama serve</code>) if you want the real one.
      </p>
      {detail && <p className="text-muted readout mt-2 text-xs">{detail}</p>}
    </Panel>
  );
}

export interface HarnessExerciseProps extends ExerciseComponentProps {
  /** Injected by the test suite: jsdom has no `Worker`. */
  createWorker?: WorkerFactory;
}

export function HarnessExercise({ exercise, createWorker }: HarnessExerciseProps) {
  const config = parseExerciseConfig('harness', exercise.config);
  const saved = useExercisePersistence(exercise);
  const health = useModelHealth();
  const runner = useHarnessRunner(createWorker);

  const savedState = saved.state as Record<string, unknown>;
  const [code, setCode] = useState(() =>
    typeof savedState.code === 'string' && savedState.code.trim() !== ''
      ? (savedState.code as string)
      : config.starterCode,
  );
  const [reflection, setReflection] = useState(() =>
    typeof savedState.reflection === 'string' ? (savedState.reflection as string) : '',
  );
  const [confirmingReset, setConfirmingReset] = useState(false);

  const { patchState, reportTasks } = saved;
  useEffect(() => {
    patchState({ code });
  }, [patchState, code]);

  // ------------------------------------------------------------------ checks ----

  const checkResults = useMemo(() => evaluateHarnessChecks(runner.outcomes), [runner.outcomes]);
  const byCheck = new Map(checkResults.map((result) => [result.id, result]));
  const realPassed = realRunPassed(runner.run);

  const passingIds = config.tasks
    .filter((task) => {
      const checkId = scriptedCheckOf(task);
      return checkId === null ? realPassed : (byCheck.get(checkId)?.passed ?? false);
    })
    .map((task) => task.id);

  const passingKey = passingIds.join(',');
  useEffect(() => {
    if (passingKey === '') return;
    reportTasks(passingKey.split(','));
  }, [passingKey, reportTasks]);

  const completedIds = new Set(saved.tasksCompleted);
  const tasks: TaskView[] = config.tasks.map((task) => {
    const checkId = scriptedCheckOf(task);
    const result = checkId === null ? null : byCheck.get(checkId);
    const passing = checkId === null ? realPassed : (result?.passed ?? false);
    // The failure reason replaces the hint once there is one: a learner staring at a red
    // tick wants to know what was not true, not to be told again what to aim for.
    const detail = !passing && result && result.reason !== '' ? result.reason : task.hintMd;
    return {
      id: task.id,
      label: task.label,
      ...(detail ? { hintMd: detail } : {}),
      passing,
      completed: completedIds.has(task.id),
    };
  });
  const required = exercise.completionRule.type === 'tasks' ? exercise.completionRule.required : 3;

  // ----------------------------------------------------------------- actions ----

  const modelDown = health.data !== undefined && !health.data.ok;
  const busy = runner.busy;

  async function onRunScripted(): Promise<void> {
    await runner.runScripted(code, config.scriptedScenarios, config.scriptedMaxIterations);
  }

  async function onRunReal(): Promise<void> {
    await runner.runReal(code, {
      exerciseId: exercise.id,
      systemPrompt: config.realRun.systemPrompt,
      userPrompt: config.realRun.userPrompt,
      maxIterations: config.realRun.maxIterations,
      toolNames: config.workerTools,
    });
  }

  function onReset(): void {
    if (!confirmingReset) {
      setConfirmingReset(true);
      return;
    }
    setCode(config.starterCode);
    setConfirmingReset(false);
  }

  const consoleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Follow the tail, the way a terminal does.
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [runner.logs]);

  return (
    <div className="space-y-5">
      {modelDown && (
        <UnavailableBanner {...(health.data?.detail ? { detail: health.data.detail } : {})} />
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------------- left ---- */}
        <div className="space-y-5">
          <Panel className="space-y-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Eyebrow>runAgent(model, tools, userMessage, options)</Eyebrow>
              <span className="readout text-muted text-xs">runs in a Web Worker in this tab</span>
            </div>

            <CodeEditor
              value={code}
              onChange={setCode}
              disabled={busy}
              label="Your runAgent implementation"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void onRunScripted()}
                disabled={busy}
                data-testid="run-scripted"
              >
                {runner.status === 'scripted' ? 'Checking…' : 'Run scripted checks'}
              </Button>
              <Button
                onClick={() => void onRunReal()}
                disabled={busy || modelDown}
                data-testid="run-real"
                title={
                  modelDown
                    ? 'No model provider is reachable; the scripted checks still work.'
                    : undefined
                }
              >
                {runner.status === 'real' ? 'Running…' : 'Run against Gemma'}
              </Button>
              <Button onClick={runner.cancel} disabled={!busy} data-testid="cancel">
                Cancel
              </Button>
              <Button onClick={onReset} disabled={busy} data-testid="reset-code">
                {confirmingReset ? 'Really reset? This deletes your code' : 'Reset to starter'}
              </Button>
              {busy && (
                <span className="readout text-muted text-xs" data-testid="elapsed">
                  {fmtSeconds(runner.elapsedMs)} elapsed
                  {runner.status === 'real'
                    ? ' · each model call is 9–25 s warm, ~70 s cold'
                    : ' · the scripted model is instant; if this climbs, your loop is spinning'}
                </span>
              )}
            </div>

            {runner.error !== null && (
              <p className="readout text-xs text-rose-600" data-testid="runner-error">
                {runner.error}
              </p>
            )}
          </Panel>

          {/* --------------------------------------------------------- console ---- */}
          <Panel className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Eyebrow>Console</Eyebrow>
              <Button
                variant="ghost"
                onClick={runner.clearLogs}
                disabled={runner.logs.length === 0}
              >
                clear
              </Button>
            </div>
            <div
              ref={consoleRef}
              className="bg-sunk mt-2 max-h-56 overflow-auto rounded-md p-2 font-mono text-[11px] leading-5"
              data-testid="harness-console"
            >
              {runner.logs.length === 0 ? (
                <p className="text-muted">
                  Nothing yet. <code>console.log</code> from your loop arrives here — it is the only
                  debugger a worker gives you, and it is enough.
                </p>
              ) : (
                runner.logs.map((line) => (
                  <p
                    key={line.id}
                    className={
                      line.level === 'error'
                        ? 'text-rose-600'
                        : line.level === 'warn'
                          ? 'text-amber-600'
                          : ''
                    }
                  >
                    {line.text}
                  </p>
                ))
              )}
            </div>
          </Panel>
        </div>

        {/* ------------------------------------------------------------ right ---- */}
        <div className="space-y-5">
          <TaskList
            tasks={tasks}
            required={required}
            {...(config.reflectionMd ? { reflectionMd: config.reflectionMd } : {})}
            reflection={reflection}
            onReflectionChange={(value) => {
              setReflection(value);
              patchState({ reflection: value });
            }}
          />

          <AgentTrace
            steps={runner.steps}
            isRunning={runner.status === 'real'}
            emptyMessage="The scripted checks run entirely in your browser and leave no trace. Press “Run against Gemma” to file a real run, and the tool calls your loop makes will show up here."
          />

          {runner.run && (
            <Panel className="p-4" data-testid="real-run-summary">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Eyebrow>Real run</Eyebrow>
                <Link
                  to={`/runs/${runner.run.id}`}
                  className="readout text-muted hover:text-ink text-xs underline"
                  data-testid="run-link"
                >
                  run {runner.run.id.slice(0, 8)}
                </Link>
              </div>
              {runner.run.finalOutput ? (
                <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">
                  {runner.run.finalOutput}
                </p>
              ) : (
                <p className="text-muted mt-2 text-sm leading-6">
                  The run ended as <strong>{runner.run.status}</strong> without a final answer
                  {runner.run.errorMessage ? `: ${runner.run.errorMessage}` : '.'}
                </p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Readout label="Status" value={runner.run.status} />
                <Readout
                  label="Model calls"
                  value={runner.run.iterationCount}
                  hint="Counted by the server, one per POST /model/chat your worker asked for"
                />
                <Readout label="Tool calls" value={runner.run.toolCallCount} />
                <Readout
                  label="Inference"
                  value={fmtSeconds(runner.run.modelLatencyMsTotal)}
                  hint="Summed across every model call. Tool execution is single-digit milliseconds."
                />
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
