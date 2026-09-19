import type { RunStep, RunStepKind } from '@lab/shared';
import { useState } from 'react';

import { Eyebrow, Panel } from '../../components/ui';

/**
 * The trace viewer: one card per `agent_run_steps` row, in order, grouped by iteration.
 *
 * **Presentational and data-driven only.** It takes `RunStep[]` and nothing else — no
 * query, no `runId`, no knowledge of where the steps came from. That is a requirement
 * rather than a preference: this component renders the server loop's trace in Module 5,
 * the learner's own in-browser loop in Module 6, and a historical failure in the SRE
 * lesson, and it must render all three identically. Any data fetching it did would have
 * to be right for all three, which is how a shared component turns into three components
 * wearing a trench coat.
 *
 * **It is a list, not a table.** An `<ol>` of `<li>`s with a real heading per card, so a
 * screen reader gets "step 3 of 9, tool result, calculator, error" rather than a grid of
 * cells to navigate. The JSON payloads are `<details>` elements, which are keyboard
 * operable and announce their own expanded state without any ARIA at all.
 */

const KIND_LABEL: Record<RunStepKind, string> = {
  model_call: 'model call',
  tool_call: 'tool call',
  tool_result: 'tool result',
  final: 'final answer',
  error: 'error',
};

/**
 * Colour-coded by kind, with the accent on the left edge rather than as a background:
 * a full-bleed tint on five kinds at once reads as a fruit salad, and the trace is
 * something people scan down.
 */
const KIND_ACCENT: Record<RunStepKind, string> = {
  model_call: 'border-l-sky-500',
  tool_call: 'border-l-violet-500',
  tool_result: 'border-l-emerald-500',
  final: 'border-l-ink',
  error: 'border-l-rose-500',
};

const fmtMs = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function Badge({
  children,
  tone = 'plain',
}: {
  children: React.ReactNode;
  tone?: 'plain' | 'error';
}) {
  return (
    <span
      className={`readout rounded-sm border px-1.5 py-0.5 text-[10px] tracking-wide ${
        tone === 'error' ? 'border-rose-500 text-rose-600' : 'border-rule text-muted'
      }`}
    >
      {children}
    </span>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(value, null, 2);
  return (
    <details className="mt-2">
      <summary className="readout text-muted hover:text-ink cursor-pointer text-[11px]">
        {label}
      </summary>
      <pre className="bg-sunk mt-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap">
        {text}
      </pre>
    </details>
  );
}

function StepCard({ step, total }: { step: RunStep; total: number }) {
  const title = step.toolName
    ? `${KIND_LABEL[step.kind]} · ${step.toolName}`
    : KIND_LABEL[step.kind];
  return (
    <li
      className={`border-rule bg-surface rounded-md border border-l-4 p-3 ${KIND_ACCENT[step.kind]} ${
        step.isError ? 'bg-rose-50/60 dark:bg-rose-950/20' : ''
      }`}
      data-testid={`step-${step.stepIndex}`}
      data-kind={step.kind}
      data-error={step.isError ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-medium">
          <span className="sr-only">
            Step {step.stepIndex + 1} of {total}:{' '}
          </span>
          {title}
        </h4>
        <div className="flex flex-wrap items-center gap-1.5">
          {step.isError && <Badge tone="error">error</Badge>}
          {step.parseOk === false && <Badge tone="error">parse failed</Badge>}
          {step.latencyMs !== null && <Badge>{fmtMs(step.latencyMs)}</Badge>}
          {step.promptTokens !== null && (
            <Badge>
              {step.promptTokens}/{step.completionTokens ?? 0} tok
            </Badge>
          )}
          <Badge>#{step.stepIndex}</Badge>
        </div>
      </div>

      {step.content !== null && step.content.trim() !== '' && (
        <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">{step.content}</p>
      )}
      {step.kind === 'model_call' && (step.content === null || step.content.trim() === '') && (
        // Worth saying rather than leaving blank: "the model said nothing and asked for a
        // tool" is a real observation, and an empty card looks like a rendering bug.
        <p className="text-muted mt-2 text-xs italic">
          No text — the model spent this call deciding to use a tool.
        </p>
      )}

      <Json label="arguments" value={step.toolArgs} />
      {step.toolArgsRaw !== null && (
        <Json label="raw arguments (parsing failed)" value={step.toolArgsRaw} />
      )}
      <Json label="result" value={step.toolResult} />
      <Json label="provider metadata" value={step.raw} />
    </li>
  );
}

export interface AgentTraceProps {
  steps: readonly RunStep[];
  /** Shown while a run is live so an empty trace does not look broken. */
  isRunning?: boolean;
  /** Rendered instead of the empty-state copy when there is nothing yet. */
  emptyMessage?: string;
}

export function AgentTrace({ steps, isRunning = false, emptyMessage }: AgentTraceProps) {
  const [grouped, setGrouped] = useState(true);
  const iterations = [...new Set(steps.map((step) => step.iteration))].sort((a, b) => a - b);

  if (steps.length === 0) {
    return (
      <Panel className="p-4" data-testid="agent-trace">
        <Eyebrow>Trace</Eyebrow>
        <p className="text-muted mt-2 text-sm leading-6" data-testid="trace-empty">
          {isRunning
            ? 'Waiting for the first step. Local inference takes 6–45 seconds per call, and the first call of the day is slower still.'
            : (emptyMessage ?? 'No steps yet. Press Run to start an agent run.')}
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="p-4" data-testid="agent-trace">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>Trace</Eyebrow>
        <div className="flex items-center gap-2">
          <span className="readout text-muted text-xs" data-testid="trace-count">
            {steps.length} steps · {iterations.length} iterations
          </span>
          <label className="readout text-muted flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(event) => setGrouped(event.target.checked)}
            />
            group by iteration
          </label>
        </div>
      </div>

      {grouped ? (
        <div className="mt-3 space-y-4">
          {iterations.map((iteration) => (
            <section key={iteration} aria-label={`Iteration ${iteration}`}>
              <h3 className="eyebrow">iteration {iteration}</h3>
              <ol className="mt-1.5 space-y-2">
                {steps
                  .filter((step) => step.iteration === iteration)
                  .map((step) => (
                    <StepCard key={step.stepIndex} step={step} total={steps.length} />
                  ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <ol className="mt-3 space-y-2" aria-label="Run steps">
          {steps.map((step) => (
            <StepCard key={step.stepIndex} step={step} total={steps.length} />
          ))}
        </ol>
      )}

      {isRunning && (
        <p className="text-muted readout mt-3 text-xs" data-testid="trace-live">
          streaming…
        </p>
      )}
    </Panel>
  );
}
