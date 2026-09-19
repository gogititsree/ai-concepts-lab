import { z } from 'zod';

/**
 * Every environment variable the API reads, in one place, parsed once at startup.
 * Missing or bad values must kill the process immediately with a readable message rather
 * than surfacing as `undefined` deep inside a request handler.
 */
/**
 * `z.coerce.boolean()` is a trap for env vars: it follows JavaScript truthiness, so the
 * string `'false'` becomes `true`. This accepts only the spellings people actually write
 * in a `.env` file and rejects everything else loudly.
 */
const BooleanFromEnv = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) =>
    typeof value === 'boolean' ? value : value === 'true' || value === '1' || value === 'yes',
  );

/**
 * Used when `SESSION_SECRET` is unset outside production, so `pnpm dev` and the test
 * suites work on a fresh clone. Production has no fallback: the superRefine below fails
 * the boot instead. `pnpm setup:env` writes a real random secret into `.env`.
 */
const DEV_SESSION_SECRET = 'dev-only-insecure-session-secret-do-not-use-in-production';

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

  // ------------------------------------------------------------------- auth (M5) ----

  /**
   * Signing key for the `sid` cookie (@fastify/cookie). It is *not* the session secret in
   * the JWT sense: the cookie value is an opaque 32-byte random token whose sha256 is the
   * primary key of `sessions`. The signature only lets the API discard forged or
   * truncated cookies before it spends a database round-trip on them, which also means
   * rotating this key logs everyone out — acceptable, and cheaper than the alternative.
   * 32 bytes is the floor because HMAC-SHA256 keys shorter than their block security
   * level buy nothing.
   */
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  /**
   * The browser origin the SPA is served from. Non-GET requests whose `Origin` header is
   * present must match it (CSRF defence #2, alongside `X-Requested-With`). In dev this is
   * the Vite dev server; in production the API serves the SPA, so it is the API's own
   * public URL.
   */
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  /**
   * `Secure` on the session cookie. Defaults to true in production and false elsewhere,
   * because a `Secure` cookie is silently dropped over plain http://localhost — which
   * looks exactly like a broken login.
   */
  COOKIE_SECURE: BooleanFromEnv.optional(),
  /**
   * Trust `X-Forwarded-For`/`X-Forwarded-Proto`. Off by default: with no proxy in front,
   * trusting those headers lets any client claim any IP and thereby dodge the per-IP rate
   * limits. Render terminates TLS in front of the container, so the deployment sets it.
   */
  TRUST_PROXY: BooleanFromEnv.default(false),
});

const ConfigSchema = EnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.SESSION_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_SECRET'],
      message: 'is required in production (at least 32 characters) — run `pnpm setup:env`',
    });
  }
}).transform((env) => ({
  ...env,
  SESSION_SECRET: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
  // `new URL(...).origin` normalises away a trailing slash and any path, so
  // `http://localhost:5173/` in a .env still compares equal to the browser's `Origin`.
  APP_ORIGIN: new URL(env.APP_ORIGIN).origin,
  COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
}));

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse({
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
