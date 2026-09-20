import {
  CreateRunResponseSchema,
  RunDetailSchema,
  type CreateRunRequest,
  type RunDetail,
} from '@lab/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet, apiPost, type ApiError } from '../../../lib/apiClient';
import { useRunStream } from '../../runs/queries';
import {
  isModelUnavailableError,
  MODEL_UNAVAILABLE_CODE,
  useRefreshModelHealth,
} from '../prompt/useChatRun';

/**
 * One agent run, from `POST /model/runs` to the completed trace.
 *
 * The shape of this hook is dictated by the shape of the feature: the server answers
 * `202 {runId}` in milliseconds and the actual work takes one to four minutes. So there
 * are three phases rather than a request and a response —
 *
 *   1. **create** (fast): a `runId` comes back.
 *   2. **watch** (slow): steps arrive over SSE and the trace animates.
 *   3. **settle**: the stream's `end` event carries the final summary, and the hook
 *      fetches the run one more time from the database.
 *
 * That last fetch is not redundant. The task checks run against the *persisted* run, so
 * they must read what Postgres has rather than what the socket delivered — those agree
 * in every normal case, and when they do not, the database is right. It costs one cheap
 * query at the end of a run that took two minutes.
 *
 * The elapsed counter and the cancel button are the same pattern as the Module 4
 * playground, for the same reason, only more so: a prompt call is 6–45 seconds and an
 * agent run is several of them back to back.
 */

const TICK_MS = 100;

export type AgentRunStatus = 'idle' | 'starting' | 'running' | 'done' | 'error';

export interface AgentRunState {
  status: AgentRunStatus;
  runId: string | null;
  /** The live trace while running, then the persisted one. */
  run: RunDetail | null;
  steps: RunDetail['steps'];
  error: ApiError | Error | null;
  elapsedMs: number;
  start: (request: CreateRunRequest) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

export function useAgentRun(): AgentRunState {
  const refreshModelHealth = useRefreshModelHealth();
  const [status, setStatus] = useState<AgentRunStatus>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const live = useRunStream(runId, status === 'running');

  useEffect(() => {
    if (status !== 'starting' && status !== 'running') return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), TICK_MS);
    return () => clearInterval(timer);
  }, [status]);

  // The stream said the run is over: read the durable version and settle.
  useEffect(() => {
    if (status !== 'running' || live.status !== 'ended' || !runId) return;
    let cancelled = false;
    void (async () => {
      try {
        const detail = await apiGet(`/model/runs/${runId}`, RunDetailSchema);
        if (cancelled || !mounted.current) return;
        setRun(detail);
        setStatus('done');
        // `POST /model/runs` answers 202 and the provider dies *afterwards*, so unlike
        // module 4 there is no rejected promise to read: the only place the agent path
        // ever says MODEL_UNAVAILABLE is the terminal run row. Reading it from the
        // persisted detail rather than from the SSE `end` summary keeps this on the same
        // source of truth as the trace and the task checks, and costs milliseconds.
        if (detail.errorCode === MODEL_UNAVAILABLE_CODE) refreshModelHealth();
      } catch (caught) {
        if (cancelled || !mounted.current) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, live.status, runId, refreshModelHealth]);

  const start = useCallback(
    async (request: CreateRunRequest) => {
      setStatus('starting');
      setError(null);
      setRun(null);
      setRunId(null);
      try {
        const created = await apiPost('/model/runs', {
          body: request,
          schema: CreateRunResponseSchema,
        });
        if (!mounted.current) return;
        setRunId(created.runId);
        setStatus('running');
      } catch (caught) {
        if (!mounted.current) return;
        // `MODEL_PROVIDER=none` refuses the run outright, before there is a run row.
        if (isModelUnavailableError(caught)) refreshModelHealth();
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setStatus('error');
      }
    },
    [refreshModelHealth],
  );

  const cancel = useCallback(async () => {
    if (!runId) return;
    try {
      await apiPost(`/model/runs/${runId}/cancel`);
    } catch (caught) {
      // A failed cancel is worth showing: the run is still burning inference.
      if (mounted.current) setError(caught instanceof Error ? caught : new Error(String(caught)));
    }
    // No status change here. The server marks the run cancelled, the stream ends, and
    // the effect above fetches the real terminal state — so the UI reports what actually
    // happened rather than what was asked for.
  }, [runId]);

  const reset = useCallback(() => {
    setStatus('idle');
    setRunId(null);
    setRun(null);
    setError(null);
  }, []);

  return {
    status,
    runId,
    run,
    // Live steps while running, persisted steps once settled.
    steps: status === 'done' && run ? run.steps : live.steps,
    error,
    elapsedMs,
    start,
    cancel,
    reset,
  };
}
