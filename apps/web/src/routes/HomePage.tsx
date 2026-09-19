import type { HealthResponse } from '@lab/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { Eyebrow, Panel, ProgressRing } from '../components/ui';
import {
  ErrorPanel,
  LoadingPanel,
  SignInPanel,
  isUnauthenticated,
} from '../features/content/QueryStates';
import { useProgress } from '../features/content/queries';
import { fetchHealth } from '../lib/api';
import { queryKeys } from '../lib/queryClient';

/**
 * The dashboard: where you are in the course, and whether the machinery behind it is up.
 *
 * Progress comes from `GET /progress` (M7), which means this page needs a session for
 * the rings — but not for anything else. A signed-out visitor still gets the pitch, the
 * curriculum link and the health tile, with one panel inviting them in. Degrading to
 * *less* rather than to a redirect is the same choice the module pages make.
 */
export function HomePage() {
  const progress = useProgress();
  const health = useQuery<HealthResponse>({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => fetchHealth(signal),
  });

  const modules = progress.data?.modules ?? [];
  const started = modules.filter((entry) => entry.progress.fraction > 0);
  const next = progress.data?.nextModuleSlug ?? null;
  const nextTitle = modules.find((entry) => entry.moduleSlug === next)?.moduleTitle;

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
              to={`/modules/${next}`}
              data-testid="continue-link"
              className="readout border-rule bg-surface hover:bg-sunk inline-flex rounded-md border px-3 py-2 text-xs font-medium"
            >
              {started.length === 0 ? 'Start Module 1' : `Continue: ${nextTitle ?? next}`}
            </Link>
          )}
        </div>
      </header>

      <section>
        <Eyebrow>Progress</Eyebrow>
        {progress.isPending && <LoadingPanel label="Loading your progress…" />}
        {progress.error && isUnauthenticated(progress.error) && (
          <SignInPanel className="mt-3" what="see your progress" />
        )}
        {progress.error && !isUnauthenticated(progress.error) && (
          <ErrorPanel
            className="mt-3"
            error={progress.error}
            onRetry={() => {
              void progress.refetch();
            }}
          />
        )}
        {progress.data && (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {modules.map((entry) => (
              <li key={entry.moduleSlug}>
                <Panel className="hover:border-ink/40 transition-colors">
                  <Link
                    to={`/modules/${entry.moduleSlug}`}
                    className="flex items-center gap-3 p-4"
                    data-testid="dashboard-module"
                  >
                    <ProgressRing fraction={entry.progress.fraction} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {entry.moduleTitle}
                      </span>
                      <span className="readout text-muted block text-xs">
                        {entry.progress.lessonsDone}/{entry.progress.lessonsTotal} lessons
                        {entry.progress.quizPassed ? ' · quiz passed' : ''}
                      </span>
                    </span>
                  </Link>
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <Eyebrow>Backend</Eyebrow>
        <Panel className="mt-3 p-4">
          {health.isPending && <p className="readout text-muted text-sm">Checking...</p>}
          {health.error && (
            <div className="text-sm">
              <p className="readout">
                API unreachable <span className="text-muted">({health.error.message})</span>
              </p>
              <p className="text-muted mt-1 text-xs leading-5">
                The curriculum now comes from the API, so nothing on this site works without it.
                Start it with <code>pnpm --filter api dev</code>.
              </p>
            </div>
          )}
          {health.data && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">status</dt>
              <dd data-testid="health-status" className="readout">
                {health.data.status}
              </dd>
              <dt className="text-muted">version</dt>
              <dd data-testid="health-version" className="readout">
                {health.data.version}
              </dd>
            </dl>
          )}
        </Panel>
      </section>
    </div>
  );
}
