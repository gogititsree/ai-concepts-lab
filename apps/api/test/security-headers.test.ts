import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  buildCspDirectives,
  isWorkerScriptRequest,
  PERMISSIONS_POLICY,
  serializeCsp,
  WORKER_ASSET_PATTERN,
  WORKER_CSP,
} from '../src/plugins/security.js';

/**
 * The security headers (M13).
 *
 * These assertions look pedantic — "the policy contains `data:`" — and that is the
 * point. A CSP directive is only ever wrong in production, silently, in a feature
 * nobody exercises on the day of the deploy: a missing `data:` means the MFA QR code is
 * a broken image, a missing `worker-src` means Module 6 never starts. Each `it()` below
 * names the feature it is protecting, so a future change that tightens the policy fails
 * with a sentence rather than a diff of two long strings.
 */

/** A config that looks like the Render deployment. */
function productionConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pw@db.example:5432/lab',
    SESSION_SECRET: 'x'.repeat(48),
    MFA_ENCRYPTION_KEY: Buffer.from('unit-test-insecure-mfa-key-32byt').toString('base64'),
    APP_ORIGIN: 'https://ai-concepts-lab.onrender.com',
    COOKIE_SECURE: 'true',
    MODEL_PROVIDER: 'none',
    ...overrides,
  });
}

describe('buildCspDirectives', () => {
  const prod = buildCspDirectives({ development: false, tls: true });
  const dev = buildCspDirectives({ development: true, tls: false });

  it('lets the MFA enrollment QR code render (it is a data: URI)', () => {
    expect(prod['img-src']).toContain('data:');
  });

  it("lets Module 6's Web Worker start", () => {
    // Both, not one: `child-src` is the fallback in browsers that predate `worker-src`.
    expect(prod['worker-src']).toEqual(["'self'"]);
    expect(prod['child-src']).toEqual(["'self'"]);
  });

  it('lets KaTeX and CodeMirror apply inline styles', () => {
    expect(prod['style-src']).toContain("'unsafe-inline'");
  });

  it('loads the IBM Plex stylesheet and its font files from the right two origins', () => {
    expect(prod['style-src']).toContain('https://fonts.googleapis.com');
    expect(prod['font-src']).toContain('https://fonts.gstatic.com');
  });

  it('allows the one KaTeX font Vite inlines as a data: URI', () => {
    // KaTeX_Size3-Regular.woff2 is under Vite's 4 KB inline limit and ships as
    // `src: url(data:font/woff2;base64,...)`. Without this the large math delimiters
    // silently fall back to a system font — in production only.
    expect(prod['font-src']).toContain('data:');
  });

  it('never allows inline or eval script on the document, in production', () => {
    expect(prod['script-src']).toEqual(["'self'"]);
    expect(prod['script-src-attr']).toEqual(["'none'"]);
  });

  it('is looser in development, because the Vite dev server needs it', () => {
    expect(dev['script-src']).toContain("'unsafe-inline'");
    expect(dev['script-src']).toContain("'unsafe-eval'");
    // The HMR socket.
    expect(dev['connect-src']).toContain('ws:');
  });

  it('refuses to be framed and cannot be repointed with an injected <base>', () => {
    expect(prod['frame-ancestors']).toEqual(["'none'"]);
    expect(prod['base-uri']).toEqual(["'self'"]);
    expect(prod['object-src']).toEqual(["'none'"]);
  });

  it('upgrades insecure requests only when the instance is served over TLS', () => {
    expect(prod['upgrade-insecure-requests']).toEqual([]);
    expect(dev['upgrade-insecure-requests']).toBeUndefined();
  });

  it('serialises valueless directives without a trailing space', () => {
    expect(serializeCsp({ 'default-src': ["'self'"], 'upgrade-insecure-requests': [] })).toBe(
      "default-src 'self'; upgrade-insecure-requests",
    );
  });
});

describe('isWorkerScriptRequest', () => {
  it('trusts Sec-Fetch-Dest, which page script cannot forge', () => {
    expect(isWorkerScriptRequest({ headers: { 'sec-fetch-dest': 'worker' }, url: '/x.js' })).toBe(
      true,
    );
  });

  it('falls back to the built filename when Fetch Metadata is absent', () => {
    expect(
      isWorkerScriptRequest({ headers: {}, url: '/assets/harnessRunner.worker-CtCPd6Au.js' }),
    ).toBe(true);
  });

  it('leaves ordinary documents and chunks alone', () => {
    expect(isWorkerScriptRequest({ headers: { 'sec-fetch-dest': 'document' }, url: '/' })).toBe(
      false,
    );
    expect(isWorkerScriptRequest({ headers: {}, url: '/assets/index-DWUwKT6L.js' })).toBe(false);
  });

  it('matches the name Vite actually emitted, so the fallback is not fiction', () => {
    // Regression guard for the pattern itself against a real build output name.
    expect(WORKER_ASSET_PATTERN.test('/assets/harnessRunner.worker-CtCPd6Au.js')).toBe(true);
  });
});

describe('WORKER_CSP', () => {
  it("allows the eval Module 6's exercise is built on, and nothing else", () => {
    expect(WORKER_CSP).toContain("'unsafe-eval'");
    // The learner's realm holds no credentials and must not be able to reach the API.
    expect(WORKER_CSP).toContain("default-src 'none'");
    expect(WORKER_CSP).not.toContain('connect-src');
  });
});

describe('the headers an actual response carries', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('sends CSP, nosniff, referrer, permissions and HSTS on a production response', async () => {
    app = await buildApp({
      config: productionConfig(),
      webDistPath: '/nonexistent',
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/model/health' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toBe(PERMISSIONS_POLICY);
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['permissions-policy']).toContain('microphone=()');
    expect(res.headers['permissions-policy']).toContain('geolocation=()');
    expect(res.headers['strict-transport-security']).toContain('max-age=15552000');
  });

  it('does not send HSTS when the instance is not behind TLS', async () => {
    // Exactly the Playwright configuration: NODE_ENV=production over plain http.
    app = await buildApp({
      config: productionConfig({ COOKIE_SECURE: 'false' }),
      webDistPath: '/nonexistent',
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/model/health' });

    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('swaps in the worker policy for a worker script request', async () => {
    app = await buildApp({
      config: productionConfig(),
      webDistPath: '/nonexistent',
      logger: false,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/assets/harnessRunner.worker-CtCPd6Au.js',
      headers: { 'sec-fetch-dest': 'worker' },
    });

    // 404 here (no dist in this test), but the header is set in an onRequest hook, so
    // the policy is on the response either way — which is what the browser reads.
    expect(res.headers['content-security-policy']).toBe(WORKER_CSP);
  });

  it('still carries the headers on a rejected request', async () => {
    // A 403 rendered in a frame is still a clickjacking target: the headers must not
    // depend on the request having been allowed.
    app = await buildApp({
      config: productionConfig(),
      webDistPath: '/nonexistent',
      logger: false,
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login' });

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});
