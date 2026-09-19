import {
  AGENT_MAX_ITERATIONS_CAP,
  CatalogToolNameSchema,
  type AgentTask,
  type CatalogToolName,
  type CreateRunRequest,
  type MockToolDefinition,
} from '@lab/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { Button, Eyebrow, Panel, Readout } from '../../../components/ui';
import { parseExerciseConfig } from '../../content/exerciseConfig';
import { useExercisePersistence } from '../../content/useExercisePersistence';
import { AgentTrace } from '../../runs/AgentTrace';
import { useModelHealth } from '../prompt/useChatRun';
import type { ExerciseComponentProps } from '../registry';
import { TaskList, type TaskView } from '../TaskList';
import { evaluateAgentTasks } from './checks';
import { MockToolBuilder } from './MockToolBuilder';
import { useAgentRun } from './useAgentRun';

/**
 * Module 5's playground: pick tools, write a system prompt, press Run, watch the trace.
 *
 * Two things here differ from the Module 4 playground, and both come from the same fact:
 * an agent run is *several* model calls.
 *
 * **The wait is long enough to need explaining.** A two-iteration run measured 31 s warm
 * and over a minute cold on the reference machine. So the elapsed counter, the cancel
 * button and the streaming trace are not polish — without them the page is
 * indistinguishable from a hang for the first half-minute. The trace arriving step by
 * step is also the single best teaching device in the module: you *see* that inference
 * is the slow part and tool execution is instant.
 *
 * **Tasks are checked against the finished run, not against the response.** The checks
 * read `agent_run_steps`, so "the agent called the calculator before answering" is a
 * statement about the trace on screen rather than about anything this component
 * inferred. See `checks.ts`.
 */

const fmtSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function UnavailableBanner({ detail }: { detail?: string }) {
  return (
    <Panel className="border-ink/30 bg-sunk p-4" data-testid="model-unavailable-banner">
      <Eyebrow>No model attached</Eyebrow>
      <p className="mt-1 text-sm leading-6">
        This exercise runs an agent loop against a language model, and none is reachable from here.
        The deployed copy of this app runs with <code>MODEL_PROVIDER=none</code> on purpose: the
        free tier has no GPU, so modules 4&ndash;6 are <strong>run-it-locally</strong> exercises.
        Clone the repo, start Ollama (<code>ollama serve</code>) and run the app on your own
        machine.
      </p>
      {detail && <p className="text-muted readout mt-2 text-xs">{detail}</p>}
    </Panel>
  );
}

const isCatalogName = (name: string): name is CatalogToolName =>
  CatalogToolNameSchema.safeParse(name).success;

export function AgentExercise({ exercise }: ExerciseComponentProps) {
  const config = parseExerciseConfig('agent', exercise.config);
  const saved = useExercisePersistence(exercise);
  const health = useModelHealth();
  const run = useAgentRun();

  const savedState = saved.state as Record<string, unknown>;
  const str = (key: string, fallback: string): string =>
    typeof savedState[key] === 'string' ? (savedState[key] as string) : fallback;

  const [systemPrompt, setSystemPrompt] = useState(() =>
    str('systemPrompt', config.defaults.systemPrompt),
  );
  const [userPrompt, setUserPrompt] = useState(() => str('userPrompt', config.defaults.userPrompt));
  const [selected, setSelected] = useState<string[]>(() =>
    Array.isArray(savedState.tools)
      ? (savedState.tools as string[]).filter((name) => config.toolCatalog.includes(name))
      : config.defaults.tools,
  );
  const [mockTools, setMockTools] = useState<MockToolDefinition[]>([]);
  const [maxIterations, setMaxIterations] = useState(() =>
    typeof savedState.maxIterations === 'number'
      ? (savedState.maxIterations as number)
      : config.defaultMaxIterations,
  );
  const [reflection, setReflection] = useState(() => str('reflection', ''));

  const { patchState, reportTasks } = saved;
  useEffect(() => {
    patchState({ systemPrompt, userPrompt, tools: selected, maxIterations });
  }, [patchState, systemPrompt, userPrompt, selected, maxIterations]);

  const passing = useMemo(
    () => evaluateAgentTasks(config.tasks, { run: run.run, reflection }),
    [config.tasks, run.run, reflection],
  );
  const passingKey = passing.join(',');
  useEffect(() => {
    if (passingKey === '') return;
    reportTasks(passingKey.split(','));
  }, [passingKey, reportTasks]);

  const completedIds = new Set(saved.tasksCompleted);
  const tasks: TaskView[] = config.tasks.map((task) => ({
    id: task.id,
    label: task.label,
    ...(task.hintMd ? { hintMd: task.hintMd } : {}),
    passing: passing.includes(task.id),
    completed: completedIds.has(task.id),
  }));
  const required = exercise.completionRule.type === 'tasks' ? exercise.completionRule.required : 1;

  const modelDown = health.data !== undefined && !health.data.ok;
  const busy = run.status === 'starting' || run.status === 'running';
  const canRun = userPrompt.trim() !== '' && !busy;

  function toggleTool(name: string): void {
    setSelected((current) =>
      current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name],
    );
  }

  function loadTask(task: AgentTask): void {
    if (task.systemPrompt !== undefined) setSystemPrompt(task.systemPrompt);
    if (task.userPrompt !== undefined) setUserPrompt(task.userPrompt);
    if (task.tools !== undefined) setSelected(task.tools);
    if (task.maxIterations !== undefined) setMaxIterations(task.maxIterations);
    run.reset();
  }

  async function submit(): Promise<void> {
    const request: CreateRunRequest = {
      exerciseId: exercise.id,
      kind: 'agent',
      systemPrompt,
      userPrompt,
      tools: {
        catalog: selected.filter(isCatalogName),
        mock: mockTools,
      },
      maxIterations,
    };
    await run.start(request);
  }

  const summary = run.run;

  return (
    <div className="space-y-5">
      {modelDown && (
        <UnavailableBanner {...(health.data?.detail ? { detail: health.data.detail } : {})} />
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------------- left ---- */}
        <div className="space-y-5">
          <Panel className="space-y-4 p-4">
            <label className="block">
              <Eyebrow>System prompt</Eyebrow>
              <textarea
                aria-label="System prompt"
                className="border-rule bg-surface mt-1 min-h-28 w-full rounded-md border p-2 font-mono text-xs leading-6"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </label>
            <label className="block">
              <Eyebrow>User message</Eyebrow>
              <textarea
                aria-label="User message"
                className="border-rule bg-surface mt-1 min-h-24 w-full rounded-md border p-2 font-mono text-xs leading-6"
                value={userPrompt}
                onChange={(event) => setUserPrompt(event.target.value)}
              />
            </label>

            <div>
              <Eyebrow>Tools</Eyebrow>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                {config.toolCatalog.map((name) => (
                  <label key={name} className="readout flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={selected.includes(name)}
                      onChange={() => toggleTool(name)}
                      disabled={busy}
                    />
                    {name}
                  </label>
                ))}
              </div>
              <p className="text-muted mt-1.5 text-xs leading-5">
                Every tool you tick is described to the model in full, so ticking all of them is not
                free: it cost 1052 prompt tokens instead of 227 on the reference run, and four times
                the latency.
              </p>
            </div>

            <label className="block">
              <span className="eyebrow">Max iterations</span>
              <input
                aria-label="Max iterations"
                type="number"
                min={1}
                max={AGENT_MAX_ITERATIONS_CAP}
                className="border-rule bg-surface readout mt-1 w-20 rounded-md border px-2 py-1 text-xs"
                value={maxIterations}
                onChange={(event) =>
                  setMaxIterations(
                    Math.max(
                      1,
                      Math.min(AGENT_MAX_ITERATIONS_CAP, Number(event.target.value) || 1),
                    ),
                  )
                }
                disabled={busy}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void submit()} disabled={!canRun}>
                {busy ? 'Running…' : 'Run'}
              </Button>
              <Button onClick={() => void run.cancel()} disabled={!busy}>
                Cancel
              </Button>
              {busy && (
                <span className="readout text-muted text-xs" data-testid="elapsed">
                  {fmtSeconds(run.elapsedMs)} elapsed &middot; an agent run is several model calls
                </span>
              )}
              {run.status === 'error' && (
                <span className="readout text-xs text-rose-600" data-testid="run-error">
                  {run.error?.message ?? 'The run could not be started.'}
                </span>
              )}
            </div>
          </Panel>

          {config.allowMockTools && (
            <MockToolBuilder
              tools={mockTools}
              onChange={setMockTools}
              disabled={busy}
              {...(config.mockToolTemplate
                ? {
                    template: {
                      name: config.mockToolTemplate.name,
                      description: config.mockToolTemplate.description,
                      parametersText: JSON.stringify(config.mockToolTemplate.parameters, null, 2),
                      responseText: JSON.stringify(config.mockToolTemplate.response, null, 2),
                    },
                  }
                : {})}
            />
          )}

          <Panel className="p-4">
            <Eyebrow>Load a task</Eyebrow>
            <div className="mt-2 flex flex-wrap gap-2">
              {config.tasks.map((task) => (
                <Button key={task.id} onClick={() => loadTask(task)} disabled={busy}>
                  {task.id}
                </Button>
              ))}
            </div>
            <p className="text-muted mt-2 text-xs leading-5">
              Each button fills the prompts and ticks the tools that task needs. They are starting
              points; the <code>mock-tool</code> one still needs you to define the tool.
            </p>
          </Panel>
        </div>

        {/* ------------------------------------------------------------ right ---- */}
        <div className="space-y-5">
          <AgentTrace steps={run.steps} isRunning={busy} />

          {summary && (
            <Panel className="p-4" data-testid="final-answer">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Eyebrow>Final answer</Eyebrow>
                <Link
                  to={`/runs/${summary.id}`}
                  className="readout text-muted hover:text-ink text-xs underline"
                  data-testid="run-link"
                >
                  run {summary.id.slice(0, 8)}
                </Link>
              </div>
              {summary.finalOutput ? (
                <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">{summary.finalOutput}</p>
              ) : (
                <p className="text-muted mt-2 text-sm leading-6">
                  The run ended as <strong>{summary.status}</strong> without a final answer
                  {summary.errorMessage ? `: ${summary.errorMessage}` : '.'}
                </p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Readout label="Status" value={summary.status} />
                <Readout label="Iterations" value={summary.iterationCount} />
                <Readout label="Tool calls" value={summary.toolCallCount} />
                <Readout
                  label="Inference"
                  value={fmtSeconds(summary.modelLatencyMsTotal)}
                  hint="Summed across every model call in the run"
                />
              </div>
            </Panel>
          )}

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
        </div>
      </div>
    </div>
  );
}
