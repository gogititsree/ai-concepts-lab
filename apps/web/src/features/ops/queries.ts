import {
  HealthResponseSchema,
  SliResponseSchema,
  type HealthResponse,
  type SliResponse,
} from '@lab/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiGet, type ApiError } from '../../lib/apiClient';

/**
 * Reads for the `/ops` page (M14).
 *
 * Two sources, deliberately kept separate rather than merged into one endpoint:
 *
 *  - **`/ops/sli`** is computed in Postgres over `agent_runs` / `agent_run_steps`. It is
 *    the dashboard. It needs a session.
 *  - **`/health`** is the liveness probe the uptime monitor hits. It is public, because
 *    a monitor has no cookie, and it must stay cheap — so it is a separate request here
 *    too rather than something the SLI query has to wait for.
 *
 * `queryKeys` in `lib/queryClient.ts` is shared and frozen for this milestone, so these
 * keys are declared locally. They are namespaced under `ops` and cannot collide.
 */

type Query<T> = UseQueryResult<T, ApiError | Error>;

export const opsQueryKeys = {
  sli: (hours: number) => ['ops', 'sli', hours] as const,
  health: ['ops', 'health'] as const,
} as const;

export function useSli(hours: number): Query<SliResponse> {
  return useQuery({
    queryKey: opsQueryKeys.sli(hours),
    queryFn: ({ signal }) => apiGet('/ops/sli', SliResponseSchema, { signal, query: { hours } }),
    // A run takes minutes; a dashboard that refetched every few seconds would cost more
    // than it tells anyone. Thirty seconds is "fresh enough to watch a run land".
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useServiceHealth(): Query<HealthResponse> {
  return useQuery({
    queryKey: opsQueryKeys.health,
    queryFn: ({ signal }) => apiGet('/health', HealthResponseSchema, { signal }),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}
