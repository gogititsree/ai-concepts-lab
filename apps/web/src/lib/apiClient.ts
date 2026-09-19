import type { z } from 'zod';

import { ErrorResponseSchema } from '@lab/shared';

/**
 * The single place the SPA talks to the API.
 *
 * Two rules from docs/01-architecture.md are enforced here so no caller can forget them:
 *   - every state-changing request carries `X-Requested-With: fetch` (the CSRF defence that
 *     sits alongside `SameSite=Lax`; the API rejects non-GET requests without it), and
 *   - every request sends cookies, because the session lives in an HttpOnly `sid` cookie.
 *
 * Responses are parsed with the same Zod schema the API serialises them with, so contract
 * drift surfaces as a thrown error here rather than as `undefined` three components deeper.
 */

export const API_BASE = '/api/v1';

/** A structured `{error:{code,message}}` response, or a transport/parse failure. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when the caller is not logged in at all. */
  get isUnauthenticated(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }

  /** True when a password-verified session still owes a second factor. */
  get isMfaRequired(): boolean {
    return this.code === 'MFA_REQUIRED';
  }

  /** True when the model provider is unavailable (modules 4-6 on a deployment without Ollama). */
  get isModelUnavailable(): boolean {
    return this.code === 'MODEL_UNAVAILABLE';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions<TResponse> {
  method?: Method;
  body?: unknown;
  /** Schema for the success body. Omit for `204 No Content` endpoints. */
  schema?: z.ZodType<TResponse>;
  signal?: AbortSignal;
  /** Query-string parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
}

function buildUrl(path: string, query?: RequestOptions<unknown>['query']): string {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function toApiError(response: Response): Promise<ApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new ApiError(
      response.status,
      'UNKNOWN',
      `Request failed with status ${response.status}`,
    );
  }
  const parsed = ErrorResponseSchema.safeParse(payload);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(response.status, code, message, details);
  }
  return new ApiError(response.status, 'UNKNOWN', `Request failed with status ${response.status}`);
}

export async function apiRequest<TResponse = void>(
  path: string,
  options: RequestOptions<TResponse> = {},
): Promise<TResponse> {
  const { method = 'GET', body, schema, signal, query } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    // The CSRF header the API requires on every state-changing request.
    headers['X-Requested-With'] = 'fetch';
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(buildUrl(path, query), {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  if (!schema || response.status === 204) {
    return undefined as TResponse;
  }
  return schema.parse(await response.json());
}

export const apiGet = <T>(path: string, schema: z.ZodType<T>, options: RequestOptions<T> = {}) =>
  apiRequest<T>(path, { ...options, method: 'GET', schema });

export const apiPost = <T = void>(path: string, options: RequestOptions<T> = {}) =>
  apiRequest<T>(path, { ...options, method: 'POST' });

export const apiPut = <T = void>(path: string, options: RequestOptions<T> = {}) =>
  apiRequest<T>(path, { ...options, method: 'PUT' });

export const apiPatch = <T = void>(path: string, options: RequestOptions<T> = {}) =>
  apiRequest<T>(path, { ...options, method: 'PATCH' });

export const apiDelete = <T = void>(path: string, options: RequestOptions<T> = {}) =>
  apiRequest<T>(path, { ...options, method: 'DELETE' });
