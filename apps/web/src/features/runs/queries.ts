import {
  RunDetailSchema,
  RunListResponseSchema,
  RunStepSchema,
  RunSummarySchema,
  type RunDetail,
  type RunListResponse,
  type RunStep,
  type RunSummary,
} from '@lab/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { apiGet, API_BASE, type ApiError } from '../../lib/apiClient';
import { queryKeys } from '../../lib/queryClient';

/**
 * Reading agent runs: two ordinary queries and one `EventSource`.
 *
 * The split matters. `useRun` is the durable truth from Postgres and is what `/runs/:id`
 * renders for a finished run. `useRunStream` is the live tail, and it exists only to make
 * a run that takes two minutes feel like something is happening. Anything the stream
 * shows is also in the database a moment later, so a dropped connection costs animation,
 * never data — which is why the fallback for "SSE did not work" is simply to read the run
 * again rather than to degrade the feature.
 */

type Query<T> = UseQueryResult<T, ApiError | Error>;

export function useRuns(limit = 30): Query<RunListResponse> {
  return useQuery({
    queryKey: [...queryKeys.runs, limit],
    queryFn: ({ signal }) =>
      apiGet(`/model/runs?limit=${limit}`, RunListResponseSchema, { signal }),
  });
}

export function useRun(id: string | undefined): Query<RunDetail> {
  return useQuery({
    queryKey: queryKeys.run(id ?? ''),
    queryFn: ({ signal }) => apiGet(`/model/runs/${id ?? ''}`, RunDetailSchema, { signal }),
    enabled: Boolean(id),
  });
}

export type RunStreamStatus = 'idle' | 'open' | 'ended' | 'error';

export interface RunStreamState {
  steps: RunStep[];
  summary: RunSummary | null;
  status: RunStreamStatus;
}

const EMPTY: RunStreamState = { steps: [], summary: null, status: 'idle' };

/**
 * Subscribes to `GET /model/runs/:id/events` and accumulates the steps.
 *
 * Three details are load-bearing rather than incidental:
 *
 * **`EventSource` reconnects by itself**, and when it does it sends back the `id:` of the
 * last event it saw as a `Last-Event-ID` header. The server's `id:` is the step index, so
 * a reconnect resumes at exactly the right row. Nothing in this hook implements retry
 * logic; the browser's own is correct because the ids were chosen to make it correct.
 *
 * **Steps are merged by `stepIndex`, not appended.** Even with exact resumption a replay
 * can overlap (a slow close, a double-mount under React StrictMode), and a trace that
 * shows step 3 twice is worse than one that arrives a beat late.
 *
 * **The stream is closed on `end`.** Without that, `EventSource` would treat the server's
 * `end()` as a dropped connection and reconnect forever, once per second, for a run that
 * finished ten minutes ago.
 */
export function useRunStream(runId: string | null, enabled = true): RunStreamState {
  const [state, setState] = useState<RunStreamState>(EMPTY);
  // Held in a ref as well as in state so the merge does not depend on the closure that
  // the listener was created with.
  const stepsRef = useRef<Map<number, RunStep>>(new Map());

  useEffect(() => {
    if (!runId || !enabled || typeof EventSource === 'undefined') {
      setState(EMPTY);
      return;
    }
    stepsRef.current = new Map();
    setState({ steps: [], summary: null, status: 'idle' });

    const source = new EventSource(`${API_BASE}/model/runs/${runId}/events`, {
      withCredentials: true,
    });

    const publish = (patch: Partial<RunStreamState>): void => {
      const steps = [...stepsRef.current.values()].sort((a, b) => a.stepIndex - b.stepIndex);
      setState((previous) => ({ ...previous, steps, ...patch }));
    };

    source.addEventListener('open', () => publish({ status: 'open' }));

    source.addEventListener('step', (event) => {
      const parsed = RunStepSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
      if (!parsed.success) return;
      stepsRef.current.set(parsed.data.stepIndex, parsed.data);
      publish({ status: 'open' });
    });

    source.addEventListener('end', (event) => {
      const parsed = RunSummarySchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
      source.close();
      publish({ status: 'ended', ...(parsed.success ? { summary: parsed.data } : {}) });
    });

    source.addEventListener('error', () => {
      // `EventSource` fires this both for a transient drop (it will retry, readyState
      // CONNECTING) and for a real failure (CLOSED). Only the second is worth reporting;
      // reporting the first would put an error banner on every network hiccup.
      if (source.readyState === EventSource.CLOSED) publish({ status: 'error' });
    });

    return () => source.close();
  }, [runId, enabled]);

  return state;
}
