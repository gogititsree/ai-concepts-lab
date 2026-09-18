import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '../src/health.js';

describe('HealthResponseSchema', () => {
  it('accepts a healthy response with no checks', () => {
    const parsed = HealthResponseSchema.parse({ status: 'ok', version: 'dev', checks: {} });
    expect(parsed.status).toBe('ok');
  });

  it('accepts named checks with an optional detail', () => {
    const parsed = HealthResponseSchema.parse({
      status: 'degraded',
      version: 'abc123',
      checks: { model: { ok: false, detail: 'ollama unreachable' } },
    });
    expect(parsed.checks.model?.detail).toBe('ollama unreachable');
  });

  it('rejects an unknown status', () => {
    expect(() =>
      HealthResponseSchema.parse({ status: 'fine', version: 'x', checks: {} }),
    ).toThrow();
  });
});
