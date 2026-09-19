import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { MeResponseSchema, type MeResponse } from '@lab/shared';

import { ApiError, apiGet } from '../../lib/apiClient';
import { queryKeys } from '../../lib/queryClient';

/**
 * Authentication state is derived from `GET /auth/me`, not stored separately. One source of
 * truth means a logout in another tab surfaces on the next refetch instead of leaving the UI
 * convinced it is still signed in.
 *
 * `/auth/me` answers for a pending (password-verified, MFA-owing) session too, which is how
 * the second-factor screen knows who it is challenging.
 */

export type AuthStatus = 'loading' | 'anonymous' | 'pending-mfa' | 'authenticated';

export interface AuthState {
  status: AuthStatus;
  me: MeResponse | null;
  user: MeResponse['user'] | null;
  /** True once the password step passed but the second factor is still outstanding. */
  needsMfa: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  query: UseQueryResult<MeResponse | null, Error>;
}

export function useMeQuery(): UseQueryResult<MeResponse | null, Error> {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async ({ signal }) => {
      try {
        return await apiGet('/auth/me', MeResponseSchema, { signal });
      } catch (error) {
        // No session at all is a normal state for a logged-out visitor, not an error.
        if (error instanceof ApiError && error.isUnauthenticated) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export function useAuth(): AuthState {
  const query = useMeQuery();
  const me = query.data ?? null;

  let status: AuthStatus = 'loading';
  if (query.isPending) {
    status = 'loading';
  } else if (!me) {
    status = 'anonymous';
  } else if (me.session.mfaVerified) {
    status = 'authenticated';
  } else {
    status = 'pending-mfa';
  }

  return {
    status,
    me,
    user: me?.user ?? null,
    needsMfa: status === 'pending-mfa',
    isAuthenticated: status === 'authenticated',
    isLoading: status === 'loading',
    query,
  };
}
