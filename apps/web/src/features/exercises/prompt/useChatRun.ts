import {
  ModelChatResponseSchema,
  ModelHealthResponseSchema,
  type ModelChatRequest,
  type ModelChatResponse,
  type ModelHealthResponse,
} from '@lab/shared';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, apiGet, apiPost } from '../../../lib/apiClient';
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

/** The error code the API returns when the provider cannot be reached or cannot serve. */
export const MODEL_UNAVAILABLE_CODE = 'MODEL_UNAVAILABLE';

/**
 * How often the banner asks whether the provider is still there.
 *
 * 30 s, for three reasons that happen to agree: it is one Prometheus scrape interval
 * (`docker/observability/prometheus.yml`), it is what `useServiceHealth` on the `/ops`
 * page already polls at, and `GET /model/health` is a `GET /api/tags` against localhost —
 * a request cheap enough that a slower interval buys nothing.
 *
 * **Why not faster while an exercise is open, and slower otherwise?** Because there is no
 * "otherwise". `useModelHealth` is mounted by exactly four components — the module 4, 5
 * and 6 exercises and `/ops` — and every one of them is showing the answer on screen. A
 * two-speed poll would be code for a state the app cannot be in. The case a faster poll
 * would serve (a run failing right now) is handled properly below by invalidating on the
 * failure itself, which is instant rather than merely more frequent.
 *
 * **The tab:** `refetchIntervalInBackground` is left at its default `false`, so the timer
 * stops while the tab is hidden and resumes when it is shown again. A 30 s poll running
 * for hours in a forgotten background tab is a small, real cost with no reader at the
 * other end.
 */
const HEALTH_POLL_MS = 30_000;

/** `GET /model/health` — public, so it answers even before the learner has logged in. */
export function useModelHealth(): UseQueryResult<ModelHealthResponse, ApiError | Error> {
  return useQuery({
    queryKey: queryKeys.modelHealth,
    queryFn: ({ signal }) => apiGet('/model/health', ModelHealthResponseSchema, { signal }),
    // The interesting transition is "I just started Ollama"; a minute-stale banner telling
    // someone to start a server they already started is the annoying failure mode.
    //
    // That reasoning was right about the direction it considered and silently gave up the
    // other one: with no `refetchInterval` and `refetchOnWindowFocus: false` set globally
    // in `lib/queryClient.ts`, this query only ever ran on mount, so a page opened while
    // Ollama was alive could never learn that it had died. That is the whole of
    // 2026-09-20's "the banner never appeared in 121 seconds".
    staleTime: 15_000,
    retry: false,
    refetchInterval: HEALTH_POLL_MS,
    // Overrides the global `false`. Coming back to a tab is the one moment a learner is
    // most likely to have just started or just killed a model server somewhere else, and
    // `staleTime` still stops this from firing on every alt-tab.
    refetchOnWindowFocus: true,
  });
}

/**
 * True when this failure means "the provider is gone", as opposed to any other 4xx/5xx.
 *
 * `ApiError.isModelUnavailable` reads the code the API sends; everything else — an abort,
 * a 401, a Zod parse failure — says nothing about the provider and must not move the
 * banner.
 */
export function isModelUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && error.isModelUnavailable;
}

/**
 * Refetch `['model','health']` **now**.
 *
 * This is the half of the 2026-09-20 fix that matters. A poll makes the banner eventually
 * right; this makes it right at the moment the app already knows the answer. A call that
 * came back `MODEL_UNAVAILABLE`, or a run that ended with that code, is first-hand
 * evidence about the provider — better evidence than the next probe, and up to
 * `HEALTH_POLL_MS` earlier.
 *
 * It invalidates rather than writing `ok: false` into the cache directly, deliberately:
 * the banner shows `health.data.detail`, which is the server's sentence about *why*, and
 * a guess assembled in the browser would be a worse one. The refetch is a single cheap
 * GET and it is the same endpoint `/ops` reads, so there is exactly one story about
 * provider health in the app.
 */
export function useRefreshModelHealth(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.modelHealth });
  }, [queryClient]);
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

export function useChatRun(): ChatRunState {
  const refreshModelHealth = useRefreshModelHealth();
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

  const run = useCallback(
    async (request: ModelChatRequest) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setStatus('pending');
      setError(null);
      // Captured at send time: the editor may have moved on by the time the reply lands.
      setUserPrompt(
        [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? null,
      );
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
        // The provider just told us it is gone. Do not make the learner wait for a poll to
        // find out what this request already proved.
        if (isModelUnavailableError(caught)) refreshModelHealth();
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setStatus('error');
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [refreshModelHealth],
  );

  return { status, response, userPrompt, error, elapsedMs, run, cancel };
}
