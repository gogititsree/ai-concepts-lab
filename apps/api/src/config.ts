import { z } from 'zod';

/**
 * Every environment variable the API reads, in one place, parsed once at startup.
 * Missing or bad values must kill the process immediately with a readable message rather
 * than surfacing as `undefined` deep inside a request handler.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  // Build provenance, surfaced as `version` by GET /api/v1/health. The deploy workflow
  // polls that field to confirm the running image is the commit it just pushed.
  GIT_SHA: z.string().min(1).default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // No default on purpose: a mistyped or missing connection string must stop the process
  // at boot, not silently connect to some other database.
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'must be a postgres:// or postgresql:// connection string',
    ),
  // postgres.js opens connections lazily up to this many. Five is plenty for a solo app
  // on a free tier (Neon counts connections), and integration tests set it to 1-2.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse({
    ...env,
    // The CI image bakes GIT_SHA in as a build arg. When Render builds the image itself
    // there is no build arg, but Render injects the deployed commit as RENDER_GIT_COMMIT,
    // so deploy.yml can still poll /health until `version` matches the commit it shipped.
    GIT_SHA: env.GIT_SHA ?? env.RENDER_GIT_COMMIT,
  });
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export const config: Config = loadConfig();
