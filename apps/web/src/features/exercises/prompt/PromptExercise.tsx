import type { ModelChatRequest, PromptTask } from '@lab/shared';
import { useEffect, useMemo, useState } from 'react';

import { Button, Eyebrow, Panel, Readout, Slider } from '../../../components/ui';
import { parseExerciseConfig } from '../../content/exerciseConfig';
import { useExercisePersistence } from '../../content/useExercisePersistence';
import type { ExerciseComponentProps } from '../registry';
import { TaskList, type TaskView } from '../TaskList';
import { evaluatePromptTasks, type PromptOutcome } from './checks';
import { useChatRun, useModelHealth } from './useChatRun';

/**
 * Module 4's playground: two prompt boxes, three sampling knobs, a Run button, and the
 * numbers that come back.
 *
 * Two things here are not decoration.
 *
 * **The unavailable banner.** Modules 4–6 need a model and the deployed instance has
 * none (decision 1). A learner who lands here on the deployed copy gets an explanation,
 * not a button that 503s.
 *
 * **The pending state.** A call takes 6–45 seconds warm and can take another 20–40 on a
 * cold load, so there is an elapsed counter and a cancel button that really aborts. A
 * 45-second wait with no feedback is a broken UI regardless of what the server is doing.
 */

const SCHEMA_ROWS = 12;

const fmtSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function jsonOrNull(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function UnavailableBanner({ detail }: { detail?: string }) {
  return (
    <Panel className="border-ink/30 bg-sunk p-4" data-testid="model-unavailable-banner">
      <Eyebrow>No model attached</Eyebrow>
      <p className="mt-1 text-sm leading-6">
        This exercise talks to a language model, and none is reachable from here. The deployed copy
        of this app runs with <code>MODEL_PROVIDER=none</code> on purpose: the free tier has no GPU,
        so modules 4&ndash;6 are <strong>run-it-locally</strong> exercises. Clone the repo, start
        Ollama (<code>ollama serve</code>) and run the app on your own machine.
      </p>
      {detail && <p className="text-muted readout mt-2 text-xs">{detail}</p>}
    </Panel>
  );
}

export function PromptExercise({ exercise }: ExerciseComponentProps) {
  const config = parseExerciseConfig('prompt', exercise.config);
  const saved = useExercisePersistence(exercise);
  const health = useModelHealth();
  const run = useChatRun();

  const savedState = saved.state as Record<string, unknown>;
  const str = (key: string, fallback: string): string =>
    typeof savedState[key] === 'string' ? (savedState[key] as string) : fallback;
  const num = (key: string, fallback: number): number =>
    typeof savedState[key] === 'number' ? (savedState[key] as number) : fallback;

  const [systemPrompt, setSystemPrompt] = useState(() =>
    str('systemPrompt', config.defaults.systemPrompt),
  );
  const [userPrompt, setUserPrompt] = useState(() => str('userPrompt', config.defaults.userPrompt));
  const [temperature, setTemperature] = useState(() =>
    num('temperature', config.defaults.temperature),
  );
  const [topP, setTopP] = useState(() => num('topP', config.defaults.topP));
  const [seed, setSeed] = useState<string>(() =>
    savedState.seed === null || savedState.seed === undefined
      ? (config.defaults.seed?.toString() ?? '')
      : String(savedState.seed),
  );
  const [structuredMode, setStructuredMode] = useState(() => savedState.structuredMode === true);
  const [schemaText, setSchemaText] = useState(() =>
    str('schemaText', JSON.stringify(config.structuredOutput.defaultSchema, null, 2)),
  );
  const [reflection, setReflection] = useState(() => str('reflection', ''));

  const { patchState, reportTasks } = saved;

  // Debounced to 2 s by the persistence hook, so typing does not post per keystroke.
  useEffect(() => {
    patchState({
      systemPrompt,
      userPrompt,
      temperature,
      topP,
      seed: seed === '' ? null : Number(seed),
      structuredMode,
      schemaText,
    });
  }, [patchState, systemPrompt, userPrompt, temperature, topP, seed, structuredMode, schemaText]);

  const parsedSchema = useMemo(() => jsonOrNull(schemaText), [schemaText]);
  const schemaError = structuredMode && parsedSchema === null ? 'Not a JSON object' : null;

  const outcome: PromptOutcome | null = run.response
    ? {
        content: run.response.message.content,
        // The prompt as it was when the request went out, not whatever is in the editor
        // now: a task is credited to the run that attempted it.
        userPrompt: run.userPrompt ?? userPrompt,
        ...(run.response.structuredOutput ? { structured: run.response.structuredOutput } : {}),
      }
    : null;

  const passing = evaluatePromptTasks(config.tasks, outcome);
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
  const canRun = userPrompt.trim() !== '' && !schemaError && run.status !== 'pending';

  function loadTask(task: PromptTask): void {
    if (task.systemPrompt !== undefined) setSystemPrompt(task.systemPrompt);
    if (task.userPrompt !== undefined) setUserPrompt(task.userPrompt);
    setStructuredMode(task.structured);
    if (task.structured && task.check.type === 'structured') {
      setSchemaText(JSON.stringify(task.check.schema, null, 2));
    }
  }

  async function submit(): Promise<void> {
    const request: ModelChatRequest = {
      messages: [
        ...(systemPrompt.trim() === '' ? [] : [{ role: 'system' as const, content: systemPrompt }]),
        { role: 'user' as const, content: userPrompt },
      ],
      exerciseId: exercise.id,
      options: {
        temperature,
        topP,
        ...(seed.trim() === '' ? {} : { seed: Number(seed) }),
      },
      ...(structuredMode && parsedSchema ? { format: parsedSchema } : {}),
    };
    await run.run(request);
  }

  const structured = run.response?.structuredOutput;

  return (
    <div className="space-y-5">
      {modelDown && (
        <UnavailableBanner {...(health.data?.detail ? { detail: health.data.detail } : {})} />
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Panel className="space-y-4 p-4">
            <label className="block">
              <Eyebrow>System prompt</Eyebrow>
              <textarea
                aria-label="System prompt"
                className="border-rule bg-surface mt-1 min-h-24 w-full rounded-md border p-2 font-mono text-xs leading-6"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </label>
            <label className="block">
              <Eyebrow>User prompt</Eyebrow>
              <textarea
                aria-label="User prompt"
                className="border-rule bg-surface mt-1 min-h-32 w-full rounded-md border p-2 font-mono text-xs leading-6"
                value={userPrompt}
                onChange={(event) => setUserPrompt(event.target.value)}
              />
            </label>

            <div className="flex flex-wrap items-end gap-4">
              <div className="min-w-40 flex-1">
                <Slider
                  label="Temperature"
                  min={0}
                  max={2}
                  step={0.05}
                  value={temperature}
                  onChange={setTemperature}
                />
              </div>
              <div className="min-w-40 flex-1">
                <Slider label="Top-p" min={0} max={1} step={0.05} value={topP} onChange={setTopP} />
              </div>
              <label className="block">
                <span className="eyebrow">Seed</span>
                <input
                  aria-label="Seed"
                  type="number"
                  placeholder="none"
                  className="border-rule bg-surface readout mt-1 w-24 rounded-md border px-2 py-1 text-xs"
                  value={seed}
                  onChange={(event) => setSeed(event.target.value)}
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void submit()} disabled={!canRun}>
                {run.status === 'pending' ? 'Running…' : 'Run'}
              </Button>
              <Button onClick={run.cancel} disabled={run.status !== 'pending'}>
                Cancel
              </Button>
              <Button
                variant={structuredMode ? 'primary' : 'secondary'}
                aria-pressed={structuredMode}
                onClick={() => setStructuredMode(!structuredMode)}
                disabled={!config.structuredOutput.enabled}
              >
                Structured output
              </Button>
              {run.status === 'pending' && (
                <span className="readout text-muted text-xs" data-testid="elapsed">
                  {fmtSeconds(run.elapsedMs)} elapsed &middot; local inference takes 6&ndash;45 s
                </span>
              )}
              {run.status === 'cancelled' && (
                <span className="readout text-muted text-xs">cancelled</span>
              )}
            </div>
          </Panel>

          {structuredMode && (
            <Panel className="p-4">
              <div className="flex items-baseline justify-between gap-3">
                <Eyebrow>JSON schema (sent as `format`)</Eyebrow>
                {schemaError && (
                  <span className="readout text-xs font-medium" data-testid="schema-error">
                    {schemaError}
                  </span>
                )}
              </div>
              <textarea
                aria-label="JSON schema"
                spellCheck={false}
                rows={SCHEMA_ROWS}
                className="border-rule bg-surface mt-2 w-full rounded-md border p-2 font-mono text-xs leading-5"
                value={schemaText}
                onChange={(event) => setSchemaText(event.target.value)}
              />
              <p className="text-muted mt-2 text-xs leading-5">
                The schema constrains decoding <em>and</em> is re-validated on the server. If the
                first answer does not conform, the server retries once with the validation error fed
                back — and tells you that it did.
              </p>
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          <Panel className="p-4" data-testid="output-panel">
            <div className="flex items-baseline justify-between gap-3">
              <Eyebrow>Response</Eyebrow>
              {run.response && (
                <a
                  className="readout text-muted hover:text-ink text-xs underline"
                  href={`/api/v1/model/runs/${run.response.runId}`}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="run-link"
                >
                  run {run.response.runId.slice(0, 8)}
                </a>
              )}
            </div>

            {run.status === 'error' && (
              <p className="mt-2 text-sm leading-6" data-testid="run-error">
                {run.error?.message ?? 'The call failed.'}
              </p>
            )}
            {!run.response && run.status !== 'error' && (
              <p className="text-muted mt-2 text-sm leading-6">
                Nothing yet. Press Run, or load one of the tasks below.
              </p>
            )}
            {run.response && (
              <>
                <pre className="bg-sunk mt-2 max-h-80 overflow-auto rounded-md p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
                  {run.response.message.content}
                </pre>
                <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Readout label="Prompt tokens" value={run.response.usage.promptTokens} />
                  <Readout label="Completion" value={run.response.usage.completionTokens} />
                  <Readout label="Latency" value={fmtSeconds(run.response.latencyMs)} />
                  <Readout label="Model" value={run.response.model} />
                </div>
              </>
            )}
          </Panel>

          {structured && (
            <Panel className="p-4" data-testid="structured-panel">
              <div className="flex items-baseline justify-between gap-3">
                <Eyebrow>Schema validation</Eyebrow>
                <span className="readout text-xs">
                  {structured.valid ? 'valid' : 'invalid'}
                  {structured.retried ? ' · after one retry' : ' · first attempt'}
                </span>
              </div>
              {structured.valid ? (
                <pre className="bg-sunk mt-2 max-h-64 overflow-auto rounded-md p-3 font-mono text-xs leading-5">
                  {JSON.stringify(structured.value, null, 2)}
                </pre>
              ) : (
                // Verbatim, on purpose: "invalid output" is not something anyone can act on.
                <p className="mt-2 font-mono text-xs leading-5" data-testid="structured-error">
                  {structured.error}
                </p>
              )}
            </Panel>
          )}

          <Panel className="p-4">
            <Eyebrow>Load a task</Eyebrow>
            <div className="mt-2 flex flex-wrap gap-2">
              {config.tasks.map((task) => (
                <Button key={task.id} onClick={() => loadTask(task)}>
                  {task.id}
                </Button>
              ))}
            </div>
            <p className="text-muted mt-2 text-xs leading-5">
              Each button fills the prompts with a starting point. They are starting points, not
              answers — three of the four need editing before they pass.
            </p>
          </Panel>

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
