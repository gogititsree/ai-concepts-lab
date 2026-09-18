import { z } from 'zod';

/**
 * The single API contract that exists in M1. `checks` is an open record so later
 * milestones can add `db` and `model` entries without changing the shape:
 * `degraded` is the state where the app works but a dependency (e.g. Ollama) does not.
 */
export const HealthCheckSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
});

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  checks: z.record(HealthCheckSchema),
});

export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
