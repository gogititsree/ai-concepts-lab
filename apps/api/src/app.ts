import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { config as defaultConfig, type Config } from './config.js';
import { healthRoutes, type HealthRoutesOptions } from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export interface BuildAppOptions {
  config?: Config;
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
    // Trust the platform proxy (Render) for the client IP and protocol.
    trustProxy: cfg.NODE_ENV === 'production',
  });

  app.decorate('config', cfg);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Every response carries the request id; the same id is on every log line for it.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Dev only: in production the API serves the SPA from its own origin, so there is
  // nothing to cross. In dev the Vite proxy already keeps things same-origin, but CORS
  // is kept for direct API pokes from other tools/ports.
  if (cfg.NODE_ENV !== 'production') {
    await app.register(cors, { origin: true, credentials: true });
  }

  await app.register(healthRoutes, { prefix: '/api/v1', ...opts.checks });

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
