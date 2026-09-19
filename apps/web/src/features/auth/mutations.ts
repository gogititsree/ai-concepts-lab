import {
  BackupCodesResponseSchema,
  LoginResponseSchema,
  MfaEnrollResponseSchema,
  MfaVerifyResponseSchema,
  RegisterResponseSchema,
  SessionListResponseSchema,
  type BackupCodesResponse,
  type LoginRequest,
  type LoginResponse,
  type MfaEnrollResponse,
  type MfaStepUpRequest,
  type MfaVerifyResponse,
  type PasswordChangeRequest,
  type RegisterRequest,
  type RegisterResponse,
  type SessionListResponse,
} from '@lab/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';

import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '../../lib/apiClient';
import { queryKeys } from '../../lib/queryClient';

/**
 * Every write the auth screens make, as TanStack Query mutations.
 *
 * They live in one file rather than next to each page because three of them (login,
 * verify, logout) change the *same* thing — who the browser is — and that means every one
 * of them has to invalidate `queryKeys.me`. Scattering them would make "the login worked
 * but the UI still thinks you are signed out" a recurring bug rather than a single line
 * written once.
 *
 * Nothing here catches errors. The pages render `mutation.error`, which is an `ApiError`
 * carrying the API's own `code`, so a screen can distinguish `INVALID_CREDENTIALS` from
 * `LOCKED` from `RATE_LIMITED` without parsing prose.
 */

/** The one invalidation that matters: `useAuth()` reads `queryKeys.me`. */
function useInvalidateSession(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
  };
}

export function useLogin(): UseMutationResult<LoginResponse, Error, LoginRequest> {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: (body: LoginRequest) =>
      apiPost('/auth/login', { body, schema: LoginResponseSchema }),
    // Invalidated on *both* branches: `mfa_required` also changed the session (it created
    // a pending one), and the MFA screen reads `useAuth()` to know who it is challenging.
    onSuccess: invalidate,
  });
}

export function useRegister(): UseMutationResult<RegisterResponse, Error, RegisterRequest> {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: (body: RegisterRequest) =>
      apiPost('/auth/register', { body, schema: RegisterResponseSchema }),
    onSuccess: invalidate,
  });
}

export function useLogout(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost('/auth/logout'),
    onSuccess: async () => {
      // Everything cached was fetched as somebody. Clearing beats invalidating here:
      // an invalidate would refetch the *previous* user's queries against no session.
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useMfaVerify(): UseMutationResult<MfaVerifyResponse, Error, { code: string }> {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: (body: { code: string }) =>
      apiPost('/auth/mfa/verify', { body, schema: MfaVerifyResponseSchema }),
    onSuccess: invalidate,
  });
}

export function useMfaEnroll(): UseMutationResult<MfaEnrollResponse, Error, { password: string }> {
  return useMutation({
    mutationFn: (body: { password: string }) =>
      apiPost('/auth/mfa/enroll', { body, schema: MfaEnrollResponseSchema }),
  });
}

export function useMfaConfirm(): UseMutationResult<BackupCodesResponse, Error, { code: string }> {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: (body: { code: string }) =>
      apiPost('/auth/mfa/confirm', { body, schema: BackupCodesResponseSchema }),
    // `user.mfaEnabled` just flipped, and every other session was revoked.
    onSuccess: invalidate,
  });
}

export function useRegenerateBackupCodes(): UseMutationResult<
  BackupCodesResponse,
  Error,
  MfaStepUpRequest
> {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: (body: MfaStepUpRequest) =>
      apiPost('/auth/mfa/backup-codes/regenerate', { body, schema: BackupCodesResponseSchema }),
    onSuccess: invalidate,
  });
}

export function useDisableMfa(): UseMutationResult<void, Error, MfaStepUpRequest> {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: (body: MfaStepUpRequest) => apiPost('/auth/mfa/disable', { body }),
    onSuccess: invalidate,
  });
}

export function useChangePassword(): UseMutationResult<void, Error, PasswordChangeRequest> {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: (body: PasswordChangeRequest) => apiPatch('/auth/password', { body }),
    // Changing the password revokes every *other* session, so the list is now stale.
    onSuccess: invalidate,
  });
}

export function useSessions() {
  return useQuery<SessionListResponse>({
    queryKey: queryKeys.sessions,
    queryFn: ({ signal }) => apiGet('/auth/sessions', SessionListResponseSchema, { signal }),
  });
}

export function useRevokeSession(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateSession();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/auth/sessions/${id}`),
    onSuccess: invalidate,
  });
}

/**
 * Turns an unknown thrown value into something a form can show.
 *
 * The API's message is used as-is where it is already written for a human (it is, for
 * every code below); the switch exists for the two cases where the UI wants to say more
 * than the server does, and so that a new server code shows *something* rather than
 * nothing.
 */
export function authErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message
      ? error.message
      : 'Something went wrong. Please try again.';
  }
  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return 'Invalid email or password.';
    case 'LOCKED':
      return 'Too many failed attempts. This account is locked for a few minutes.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'EMAIL_TAKEN':
      return 'An account with that email already exists.';
    case 'INVALID_CODE':
      return error.message;
    case 'MFA_ALREADY_ENABLED':
      return 'Two-factor authentication is already on for this account.';
    case 'MFA_NOT_ENABLED':
      return 'Two-factor authentication is not enabled for this account.';
    case 'NO_PENDING_ENROLLMENT':
      return 'That setup expired. Start again to get a new QR code.';
    case 'VALIDATION_FAILED':
      return error.message;
    default:
      return error.message || 'Something went wrong. Please try again.';
  }
}

export { ApiError };
