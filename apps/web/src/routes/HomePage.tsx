import type { HealthResponse } from '@lab/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { Eyebrow, Panel, ProgressRing } from '../components/ui';
import { modules } from '../content/static';
import { useProgress } from '../hooks/useProgress';
import { fetchHealth } from '../lib/api';
import { summariseModule } from '../lib/localProgress';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'error'; message: string };

/**
 * The dashboard: where you are in the course, and whether the machinery behind it is up.
 *
 * The API is not required for anything on this page -- Modules 1 and 2 are static content plus
 * `@lab/nn-core` in the browser -- so a failed health check is reported as a fact and nothing
 * else changes. That property is load-bearing: `pnpm --filter web dev` with no API running has
 * to be a working app, not a spinner.
 */
export function HomePage() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  const progress = useProgress();

  // TanStack Query arrives in M7; a bare effect is enough for one call.
  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((response) => setHealth({ kind: 'ready', health: response }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setHealth({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    return () => controller.abort();
  }, []);

  const started = modules.filter((module) => summariseModule(progress, module).fraction > 0);
  const next = modules.find((module) => summariseModule(progress, module).fraction < 1);

  return (
    <div className="space-y-8">
      <header className="max-w-2xl">
        <Eyebrow>AI Concepts Lab</Eyebrow>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-balance">
          Build the intuition, then read the code that proves it.
        </h1>
        <p className="text-muted mt-3 leading-7">
          A neuron, a network that learns, a network that reads text, and the loops that turn one
          into an agent. Every visualisation on this site is driven by{' '}
          <code className="bg-sunk border-rule rounded border px-1 py-0.5 text-[0.85em]">
            @lab/nn-core
          </code>
          , the same package the test suite checks to 1e-6.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/modules"
            className="readout border-ink bg-ink text-paper inline-flex rounded-md border px-3 py-2 text-xs font-medium hover:opacity-90"
          >
            Browse the curriculum
          </Link>
          {next && (
            <Link
              to={`/modules/${next.slug}`}
              className="readout border-rule bg-surface hover:bg-sunk inline-flex rounded-md border px-3 py-2 text-xs font-medium"
            >
              {started.length === 0 ? 'Start Module 1' : `Continue: ${next.title}`}
            </Link>
          )}
        </div>
      </header>

      <section>
        <Eyebrow>Progress</Eyebrow>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((module) => {
            const summary = summariseModule(progress, module);
            return (
              <li key={module.slug}>
                <Panel className="hover:border-ink/40 transition-colors">
                  <Link
                    to={`/modules/${module.slug}`}
                    className="flex items-center gap-3 p-4"
                    data-testid="dashboard-module"
                  >
                    <ProgressRing fraction={summary.fraction} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{module.title}</span>
                      <span className="readout text-muted block text-xs">
                        {summary.lessonsCompleted}/{summary.lessonCount} lessons
                        {summary.quiz?.passed ? ' · quiz passed' : ''}
                      </span>
                    </span>
                  </Link>
                </Panel>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <Eyebrow>Backend</Eyebrow>
        <Panel className="mt-3 p-4">
          {health.kind === 'loading' && <p className="readout text-muted text-sm">Checking...</p>}
          {health.kind === 'error' && (
            <div className="text-sm">
              <p className="readout">
                API unreachable <span className="text-muted">({health.message})</span>
              </p>
              <p className="text-muted mt-1 text-xs leading-5">
                Nothing on this page needs it yet: lessons and both playgrounds run entirely in the
                browser. Start it with <code>pnpm --filter api dev</code>.
              </p>
            </div>
          )}
          {health.kind === 'ready' && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">status</dt>
              <dd data-testid="health-status" className="readout">
                {health.health.status}
              </dd>
              <dt className="text-muted">version</dt>
              <dd data-testid="health-version" className="readout">
                {health.health.version}
              </dd>
            </dl>
          )}
        </Panel>
      </section>
    </div>
  );
}
