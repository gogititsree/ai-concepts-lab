import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { mfaRoutes } from './auth/mfaRoutes.js';
import { authRoutes } from './auth/routes.js';
import { requireFullSession } from './auth/guards.js';
import { config as defaultConfig, type Config } from './config.js';
import { db as defaultDb, type Db } from './db/client.js';
import { contentRoutes } from './content/routes.js';
import { healthRoutes, type HealthRoutesOptions } from './routes/health.js';
import { progressRoutes } from './progress/routes.js';
import { registerCsrfGuard } from './plugins/csrf.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerRateLimits } from './plugins/rate-limit.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    /**
     * The Drizzle handle every route uses. Injected rather than imported at the point of
     * use so the integration suite can point one app at its own throwaway database while
     * another app in the same process uses a different one.
     */
    db: Db;
  }
}

export interface BuildAppOptions {
  config?: Config;
  /** Defaults to the application pool from `db/client.ts`. */
  db?: Db;
  /**
   * Rate limiting is on by default. Integration tests that are not about rate limits
   * switch it off, because 5 registrations per hour per IP would otherwise fail the
   * sixth test in a file for reasons that have nothing to do with the code under test.
   */
  rateLimits?: boolean;
  /** Directory containing the built SPA. Defaults to apps/web/dist next to this package. */
  webDistPath?: string;
  /** Escape hatch for tests that want to assert on logs. */
  logger?: FastifyServerOptions['logger'];
  /**
   * Dependency health probes. Unit tests stub `checkDb` so `GET /health` can be exercised
   * without Postgres; everything else gets the real `SELECT 1`.
   */
  checks?: HealthRoutesOptions;
}

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Resolved relative to this file, not to process.cwd(), so it is correct both when tsx
 * runs src/ (apps/api/src -> apps/web/dist) and when node runs dist/ inside the Docker
 * image (apps/api/dist -> apps/web/dist).
 */
export const defaultWebDistPath = resolve(here, '../../web/dist');

function loggerOptions(cfg: Config): FastifyServerOptions['logger'] {
  if (cfg.NODE_ENV === 'test') return false;
  if (cfg.NODE_ENV === 'development') {
    return {
      level: cfg.LOG_LEVEL,
      // pino-pretty is a devDependency: production logs stay as raw JSON lines for Loki.
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: cfg.LOG_LEVEL };
}

/**
 * Builds the Fastify instance without listening, so tests can drive it with
 * `app.inject()` and the server entrypoint stays a three-line file.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const cfg = opts.config ?? defaultConfig;
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(cfg),
    // Trust the platform proxy (Render) for the client IP and protocol. Off unless
    // configured: with nothing in front of the process, an honoured X-Forwarded-For lets
    // any client claim any IP and walk straight past the per-IP rate limits.
    trustProxy: cfg.TRUST_PROXY,
  });

  app.decorate('config', cfg);
  app.decorate('db', opts.db ?? defaultDb);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Every response carries the request id; the same id is on every log line for it.
  // Registered before any other hook so even a request rejected by the CSRF guard or the
  // rate limiter comes back with an id the user can quote.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // ------------------------------------------------------------------- plugins ----
  // Order is load-bearing:
  //   cookie      — the session guard cannot read `sid` until this has parsed and
  //                 unsigned it, and it must be in place before any route is registered.
  //   rate-limit  — its onRequest hook should reject a flood before the request does any
  //                 other work (including argon2, which is the expensive part).
  //   csrf        — cheap header check; rejects forged cross-site writes next.
  //   error       — the handler that renders whatever the above threw.
  //   routes      — last, so every hook above already applies to them.
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await registerRateLimits(app, { enabled: opts.rateLimits ?? true });
  registerCsrfGuard(app);
  registerErrorHandler(app);

  // Request-scoped auth state, null until a guard fills it in. Declaring the properties
  // up front keeps the request object a single hidden class instead of a new shape per
  // request, which is the whole reason Fastify has `decorateRequest`.
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);

  // Dev only: in production the API serves the SPA from its own origin, so there is
  // nothing to cross. In dev the Vite proxy already keeps things same-origin, but CORS
  // is kept for direct API pokes from other tools/ports.
  if (cfg.NODE_ENV !== 'production') {
    await app.register(cors, { origin: true, credentials: true });
  }

  // `GET /health` stays public: no guard, no rate limit (the CSRF hook exempts GET), so
  // an uptime monitor never gets a 403 or a 429 and mistakes it for an outage.
  await app.register(healthRoutes, { prefix: '/api/v1', ...opts.checks });
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(mfaRoutes, { prefix: '/api/v1' });

  // M7: the content + progress API. One encapsulated scope with the session guard as its
  // `preHandler`, so every route inside it requires a logged-in, MFA-satisfied session
  // without each handler having to remember to ask for one. `/health` is registered
  // above, outside this scope, and stays public.
  await app.register(
    async (instance) => {
      instance.addHook('preHandler', requireFullSession);
      await instance.register(contentRoutes);
      await instance.register(progressRoutes);
    },
    { prefix: '/api/v1' },
  );

  const webDistPath = opts.webDistPath ?? defaultWebDistPath;
  const serveSpa = cfg.NODE_ENV === 'production' && existsSync(webDistPath);
  if (cfg.NODE_ENV === 'production' && !serveSpa) {
    app.log.warn({ webDistPath }, 'SPA build not found; serving API only');
  }
  if (serveSpa) {
    // wildcard:false so unmatched paths fall through to the not-found handler below,
    // which is what turns this into an SPA history fallback.
    await app.register(fastifyStatic, {
      root: webDistPath,
      wildcard: false,
      index: ['index.html'],
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api');
    if (serveSpa && !isApi && request.method === 'GET') {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });

  return app;
}
