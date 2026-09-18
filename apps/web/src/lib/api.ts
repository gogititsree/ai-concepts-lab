import { HealthResponseSchema, type HealthResponse } from '@lab/shared';

/**
 * Typed fetch client. The response is parsed with the same Zod schema the API uses to
 * serialise it, so contract drift shows up as a thrown error here instead of an
 * undefined value three components deeper.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/v1/health', {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Health request failed with status ${response.status}`);
  }
  return HealthResponseSchema.parse(await response.json());
}
