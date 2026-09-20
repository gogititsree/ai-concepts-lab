import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
  CONNECT_TIMEOUT_SECONDS,
  IDLE_TIMEOUT_SECONDS,
  isPooledConnectionString,
  MAX_LIFETIME_SECONDS,
} from '../src/db/client.js';

/**
 * Pool sizing and pooler detection (M13).
 *
 * Nothing here opens a socket — postgres.js connects lazily, and the point of these
 * assertions is the *decision*, not the connection. The numbers are pinned because they
 * were chosen against a specific deployment (Render free + pooled Neon) and a later
 * "let's bump the pool" should have to edit a test that explains why they are small.
 */

describe('isPooledConnectionString', () => {
  it("recognises Neon's pooled endpoint", () => {
    expect(
      isPooledConnectionString(
        'postgresql://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require',
      ),
    ).toBe(true);
  });

  it('recognises the ?pgbouncer=true convention', () => {
    expect(isPooledConnectionString('postgres://u:p@host/db?pgbouncer=true')).toBe(true);
  });

  it('treats a direct connection as direct, so local and CI keep prepared statements', () => {
    expect(isPooledConnectionString('postgres://lab:lab@localhost:5432/lab')).toBe(false);
    expect(
      isPooledConnectionString(
        'postgresql://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/db',
      ),
    ).toBe(false);
  });

  it('does not throw on a string that is not a URL', () => {
    expect(isPooledConnectionString('nonsense')).toBe(false);
  });
});

describe('pool defaults', () => {
  it('defaults DB_POOL_MAX to 3', () => {
    // Deliberately lowered from 5 in M13: the Neon free-tier connection allowance is
    // shared with the pre-deploy migration job and any ad-hoc shell.
    const cfg = loadConfig({ DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab' });
    expect(cfg.DB_POOL_MAX).toBe(3);
  });

  it('still honours an explicit DB_POOL_MAX', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab',
      DB_POOL_MAX: '10',
    });
    expect(cfg.DB_POOL_MAX).toBe(10);
  });

  it('closes idle connections and recycles busy ones', () => {
    // Idle < lifetime < forever. An idle connection holds a slot in the pooler and can
    // keep a scale-to-zero compute awake; a very old one gets closed by the proxy
    // mid-query instead of by us between queries.
    expect(IDLE_TIMEOUT_SECONDS).toBeLessThan(MAX_LIFETIME_SECONDS);
    expect(CONNECT_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(5);
    expect(CONNECT_TIMEOUT_SECONDS).toBeLessThanOrEqual(15);
  });
});
