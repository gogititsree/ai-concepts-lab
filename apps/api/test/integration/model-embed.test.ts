import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * `POST /api/v1/model/embed` (M8), against a real database and **no model**.
 *
 * The 503 is the interesting case, not the sad one. Module 3's embeddings tab is
 * specified to work with `MODEL_PROVIDER=none` — the deployed configuration — by falling
 * back to the vectors shipped in `content/`. That fallback is only reachable if this
 * route answers quickly with a machine-readable `MODEL_UNAVAILABLE`, so that is what is
 * asserted here. The happy path needs a running Ollama and is therefore a manual check,
 * recorded in the milestone notes rather than in CI.
 */

const APP_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };

let ctx: TestDb;
let app: FastifyInstance;
let cookie: string;

function sessionCookie(res: InjectResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const sid = list.find((entry) => entry.startsWith('sid='));
  if (!sid) throw new Error(`No sid cookie in response: ${JSON.stringify(raw)}`);
  return sid.split(';')[0] as string;
}

const embed = (payload: unknown, auth = true) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/model/embed',
    headers: auth ? { ...WRITE_HEADERS, cookie } : WRITE_HEADERS,
    payload,
  });

beforeAll(async () => {
  ctx = await setupTestDb();
  app = await buildApp({
    config: loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: ctx.url,
      SESSION_SECRET: 'integration-test-session-secret-0123456789',
      APP_ORIGIN,
      // The point of the file. `fake` is the suite default (vitest.integration.config.ts);
      // this one app deliberately has no provider at all.
      MODEL_PROVIDER: 'none',
    }),
    db: ctx.db,
    rateLimits: false,
    checks: { checkDb: async () => ({ ok: true }) },
  });
  await app.ready();

  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: WRITE_HEADERS,
    payload: { email: 'embed@example.test', password: PASSWORD, displayName: 'Embed' },
  });
  expect(registered.statusCode).toBe(201);
  cookie = sessionCookie(registered);
});

afterAll(async () => {
  await app?.close();
  await ctx?.teardown();
});

describe('POST /model/embed', () => {
  it('401s without a session', async () => {
    const res = await embed({ texts: ['cat'] }, false);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('403s a write with no CSRF header, like every other non-GET route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/model/embed',
      headers: { cookie, origin: APP_ORIGIN },
      payload: { texts: ['cat'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('503s with MODEL_UNAVAILABLE when MODEL_PROVIDER is none', async () => {
    const res = await embed({ texts: ['cat', 'dog'] });
    expect(res.statusCode).toBe(503);

    const body = res.json();
    expect(body.error.code).toBe('MODEL_UNAVAILABLE');
    // The message names the reason: the tab shows it next to the "precomputed" label.
    expect(body.error.message).toContain('none');
    // The error envelope is the app-wide one, and the request is still traceable.
    expect(Object.keys(body)).toEqual(['error']);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('validates the body before it worries about the provider', async () => {
    for (const payload of [{ texts: [] }, { texts: 'cat' }, { texts: ['cat'], extra: 1 }, {}]) {
      const res = await embed(payload);
      expect(res.statusCode).toBe(400);
    }
  });
});
