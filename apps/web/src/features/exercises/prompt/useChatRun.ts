import {
  ModelChatResponseSchema,
  ModelHealthResponseSchema,
  type ModelChatRequest,
  type ModelChatResponse,
  type ModelHealthResponse,
} from '@lab/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet, apiPost, type ApiError } from '../../../lib/apiClient';
import { queryKeys } from '../../../lib/queryClient';

/**
 * The Module 4 playground's two calls to the API, and the state a *slow* call needs.
 *
 * Local inference takes 6–45 seconds warm and can take another 20–40 on a cold model
 * load. A button that greys out for forty-five seconds with no other feedback is
 * indistinguishable from a hung page, so this hook owns three things a plain
 * `useMutation` would not give for free:
 *
 *  - an **elapsed-time counter** that ticks while the request is in flight, so the wait
 *    is visibly progress rather than visibly nothing;
 *  - a **cancel** that actually aborts. The `AbortSignal` reaches `fetch`, the API passes
 *    it to the provider, and the provider passes it to Ollama — so cancelling stops the
 *    inference rather than merely stopping the page from listening to it;
 *  - a **cancelled** state distinct from an error, because the user asking for it is not
 *    a failure to report.
 */

/** How often the elapsed counter re-renders. 100 ms reads as live and costs nothing. */
const TICK_MS = 100;

export type ChatRunStatus = 'idle' | 'pending' | 'success' | 'error' | 'cancelled';

export interface ChatRunState {
  status: ChatRunStatus;
  response: ModelChatResponse | null;
  /** The user message that produced `response`, for crediting a task to the run that attempted it. */
  userPrompt: string | null;
  error: ApiError | Error | null;
  elapsedMs: number;
  run: (request: ModelChatRequest) => Promise<void>;
  cancel: () => void;
}

/** `GET /model/health` — public, so it answers even before the learner has logged in. */
export function useModelHealth(): UseQueryResult<ModelHealthResponse, ApiError | Error> {
  return useQuery({
    queryKey: queryKeys.modelHealth,
    queryFn: ({ signal }) => apiGet('/model/health', ModelHealthResponseSchema, { signal }),
    // The interesting transition is "I just started Ollama"; a minute-stale banner telling
    // someone to start a server they already started is the annoying failure mode.
    staleTime: 15_000,
    retry: false,
  });
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

export function useChatRun(): ChatRunState {
  const [status, setStatus] = useState<ChatRunStatus>('idle');
  const [response, setResponse] = useState<ModelChatResponse | null>(null);
  const [userPrompt, setUserPrompt] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  // Abort in flight on unmount: navigating away from a 40-second call should free it,
  // and a setState after unmount is a warning nobody needs.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (status !== 'pending') return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), TICK_MS);
    return () => clearInterval(timer);
  }, [status]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus('cancelled');
  }, []);

  const run = useCallback(async (request: ModelChatRequest) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setStatus('pending');
    setError(null);
    // Captured at send time: the editor may have moved on by the time the reply lands.
    setUserPrompt([...request.messages].reverse().find((m) => m.role === 'user')?.content ?? null);
    try {
      const result = await apiPost<ModelChatResponse>('/model/chat', {
        body: request,
        schema: ModelChatResponseSchema,
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      setResponse(result);
      setStatus('success');
    } catch (caught) {
      if (!mountedRef.current) return;
      // A cancel is already reflected by `cancel()`; re-reporting it as an error would
      // put a red box on the screen for something the user asked for.
      if (isAbort(caught) || controller.signal.aborted) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      setStatus('error');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  return { status, response, userPrompt, error, elapsedMs, run, cancel };
}
