import { Link, useParams } from 'react-router';

import { Eyebrow, Panel, Readout } from '../../components/ui';
import { queryFallback } from '../../features/content/QueryStates';
import { AgentTrace } from '../../features/runs/AgentTrace';
import { useRun, useRunStream } from '../../features/runs/queries';
import { ApiError } from '../../lib/apiClient';
import { NotFound } from '../NotFound';

/**
 * `/runs/:id` — one run and its trace.
 *
 * Shared by Module 5 (the server loop), Module 6 (the learner's own loop) and the SRE
 * lesson, because they all produce the same rows. If the run is still going, the page
 * tails it over SSE exactly as the exercise does — a learner who opens this in a second
 * tab while a run is in flight should see it move, not a stale snapshot.
 */

const fmtSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export function RunDetailPage() {
  const { id = '' } = useParams();
  const query = useRun(id);
  const run = query.data;
  const isRunning = run?.status === 'running';
  // Only subscribed while the run is live; a finished run is already complete in `run`.
  const live = useRunStream(isRunning ? id : null, isRunning);

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NotFound what={`Run ${id}`} />;
  }
  const fallback = queryFallback(query, {
    label: 'Loading the trace…',
    signInFor: 'see your runs',
  });
  if (fallback) return <div className="mx-auto max-w-2xl">{fallback}</div>;
  if (!run) return null;

  // Steps from the stream win while running: they are strictly newer than the snapshot.
  const steps = isRunning && live.steps.length > run.steps.length ? live.steps : run.steps;
  const tools = Array.isArray(run.tools) ? (run.tools as { name: string }[]) : [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/runs" className="eyebrow hover:text-ink">
            &larr; Runs
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {run.kind} run{' '}
            <span className="readout text-muted text-base">{run.id.slice(0, 8)}</span>
          </h1>
        </div>
        <p className="readout text-muted text-xs">
          {run.provider} · {run.model} · {new Date(run.startedAt).toLocaleString()}
        </p>
      </header>

      <Panel className="p-4" data-testid="run-summary">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Readout label="Status" value={run.status} />
          <Readout label="Iterations" value={`${run.iterationCount}/${run.maxIterations}`} />
          <Readout label="Tool calls" value={run.toolCallCount} />
          <Readout
            label="Parse failures"
            value={run.toolParseFailureCount}
            hint="Tool calls whose arguments were not valid JSON"
          />
          <Readout
            label="Tokens"
            value={`${run.promptTokensTotal}/${run.completionTokensTotal}`}
            hint="prompt / completion, summed across every model call"
          />
          <Readout label="Inference" value={fmtSeconds(run.modelLatencyMsTotal)} />
        </div>
        {run.errorCode && (
          <p className="mt-3 text-sm leading-6 text-rose-600" data-testid="run-error">
            <span className="readout">{run.errorCode}</span> — {run.errorMessage}
          </p>
        )}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-5">
          <Panel className="p-4">
            <Eyebrow>System prompt</Eyebrow>
            <pre className="bg-sunk mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-xs leading-5 whitespace-pre-wrap">
              {run.systemPrompt || '(none)'}
            </pre>
            <Eyebrow>User prompt</Eyebrow>
            <pre className="bg-sunk mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-xs leading-5 whitespace-pre-wrap">
              {run.userPrompt}
            </pre>
          </Panel>

          <Panel className="p-4" data-testid="run-tools">
            <Eyebrow>Tools offered to the model</Eyebrow>
            {tools.length === 0 ? (
              <p className="text-muted mt-1 text-sm leading-6">None.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {tools.map((tool) => (
                  <li key={tool.name} className="readout text-xs">
                    {tool.name}
                  </li>
                ))}
              </ul>
            )}
            <details className="mt-2">
              <summary className="readout text-muted hover:text-ink cursor-pointer text-[11px]">
                full definitions
              </summary>
              <pre className="bg-sunk mt-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap">
                {JSON.stringify(run.tools, null, 2)}
              </pre>
            </details>
          </Panel>

          {run.finalOutput && (
            <Panel className="p-4" data-testid="run-final">
              <Eyebrow>Final answer</Eyebrow>
              <p className="mt-1 text-sm leading-6 whitespace-pre-wrap">{run.finalOutput}</p>
            </Panel>
          )}
        </div>

        <AgentTrace
          steps={steps}
          isRunning={isRunning}
          emptyMessage="This run has no steps. It failed before the first model call, or it is a harness run whose loop has not reported anything yet."
        />
      </div>
    </div>
  );
}
