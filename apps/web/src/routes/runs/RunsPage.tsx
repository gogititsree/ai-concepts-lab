import type { RunSummary } from '@lab/shared';
import { Link } from 'react-router';

import { Eyebrow, Panel } from '../../components/ui';
import { queryFallback } from '../../features/content/QueryStates';
import { useRuns } from '../../features/runs/queries';

/**
 * `/runs` — every model call this account has made, newest first.
 *
 * It lists *all* run kinds, not just agent ones: a Module 4 prompt call and a Module 6
 * harness run are rows in the same table, and seeing them together is the point. The
 * trace is the app's memory, and this is the index of it.
 */

const STATUS_TONE: Record<string, string> = {
  running: 'border-sky-500 text-sky-600',
  completed: 'border-emerald-500 text-emerald-600',
  failed: 'border-rose-500 text-rose-600',
  cancelled: 'border-rule text-muted',
  max_iterations: 'border-amber-500 text-amber-600',
};

function duration(run: RunSummary): string {
  if (!run.finishedAt) return '—';
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function RunRow({ run }: { run: RunSummary }) {
  return (
    <li data-testid={`run-${run.id}`}>
      <Link
        to={`/runs/${run.id}`}
        className="border-rule hover:bg-sunk flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md border px-3 py-2.5 transition-colors"
      >
        <span
          className={`readout rounded-sm border px-1.5 py-0.5 text-[10px] ${
            STATUS_TONE[run.status] ?? 'border-rule text-muted'
          }`}
        >
          {run.status}
        </span>
        <span className="readout text-xs font-medium">{run.kind}</span>
        <span className="text-muted readout text-xs">
          {run.iterationCount} iter · {run.toolCallCount} tools
        </span>
        <span className="text-muted readout text-xs">
          {run.promptTokensTotal + run.completionTokensTotal} tok
        </span>
        <span className="text-muted readout text-xs">{duration(run)}</span>
        <span className="text-muted ml-auto readout text-xs">
          {new Date(run.startedAt).toLocaleString()}
        </span>
      </Link>
    </li>
  );
}

export function RunsPage() {
  const runs = useRuns();

  const fallback = queryFallback(runs, {
    label: 'Loading your runs…',
    signInFor: 'see your run history',
  });

  return (
    <section>
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="text-muted mt-2 max-w-2xl text-sm leading-6">
          Every call this app has made to a model, with the trace it left behind. Prompt runs come
          from Module 4, agent runs from Module 5&rsquo;s server-side loop, harness runs from your
          own loop in Module 6.
        </p>
      </header>

      {fallback}

      {runs.data &&
        (runs.data.runs.length === 0 ? (
          <Panel className="p-5" data-testid="runs-empty">
            <Eyebrow>Nothing yet</Eyebrow>
            <p className="mt-1 text-sm leading-6">
              Run something in the Module 4 playground or the Module 5 agent exercise and it will
              appear here.
            </p>
          </Panel>
        ) : (
          <ul className="space-y-2" data-testid="runs-list">
            {runs.data.runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        ))}
    </section>
  );
}
