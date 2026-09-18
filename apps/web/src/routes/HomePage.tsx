import type { HealthResponse } from '@lab/shared';
import { useEffect, useState } from 'react';

import { fetchHealth } from '../lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'error'; message: string };

// TanStack Query arrives in M7; a bare effect is enough for one call in the skeleton.
export function HomePage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((health) => setState({ kind: 'ready', health }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">AI Concepts Lab</h1>
        <p className="mt-1 text-sm text-slate-500">Hello world, end to end.</p>
      </header>

      <section className="rounded-lg border border-slate-200 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">API health</h2>
        {state.kind === 'loading' && <p className="mt-2">Checking...</p>}
        {state.kind === 'error' && (
          <p className="mt-2 text-red-600">Could not reach the API: {state.message}</p>
        )}
        {state.kind === 'ready' && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-slate-500">status</dt>
            <dd data-testid="health-status" className="font-mono">
              {state.health.status}
            </dd>
            <dt className="text-slate-500">version</dt>
            <dd data-testid="health-version" className="font-mono">
              {state.health.version}
            </dd>
          </dl>
        )}
      </section>
    </main>
  );
}
