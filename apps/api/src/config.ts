import { z } from 'zod';

import { decodeKeyMaterial, MfaKeyError } from './auth/crypto.js';

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

/**
 * Same deal for `MFA_ENCRYPTION_KEY` (M6): a fixed, obviously fake 32-byte key so a fresh
 * clone can enroll MFA in development and so the test suites need no setup. Production
 * has no fallback — the superRefine below refuses to boot without a real one, because a
 * committed key means every deployment shares it and the encryption at rest is theatre.
 *
 * Written as base64 of the ASCII string "dev-only-insecure-mfa-key-32bytes" minus one
 * character, i.e. exactly 32 bytes, so it is legible in a diff rather than a blob.
 */
const DEV_MFA_ENCRYPTION_KEY = Buffer.from('dev-only-insecure-mfa-key-32byte').toString('base64');

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

  // -------------------------------------------------------------------- MFA (M6) ----

  /**
   * AES-256-GCM key for the TOTP secret at rest (`docs/03-auth-mfa.md`). 32 bytes,
   * supplied as 64 hex characters or 44 base64 characters; `decodeKeyMaterial` accepts
   * either and this refinement rejects anything that is not exactly 32 bytes, at boot,
   * rather than at the first enrollment.
   *
   * It is deliberately *not* `SESSION_SECRET`. Rotating the cookie key is a routine
   * "log everyone out" lever; rotating this one makes every enrolled second factor
   * undecryptable. Different blast radius, different key.
   */
  MFA_ENCRYPTION_KEY: z.string().optional(),

  // ------------------------------------------------------------------ model (M9) ----

  /**
   * Which `ModelProvider` implementation `createProvider()` builds.
   *
   *   `ollama` — the real local model. The default in development.
   *   `fake`   — deterministic scripted responses. **Every test and CI run uses this**
   *              (CLAUDE.md: never call a real model from a test).
   *   `none`   — no model at all: `/model/*` answers `503 MODEL_UNAVAILABLE` and the UI
   *              shows the "run this locally" banner. This is what the free-tier Render
   *              deployment runs (decision 1 in docs/07-open-decisions.md).
   *
   * The default is environment-dependent rather than a constant, and that asymmetry is
   * the safety property: a production image that was never told about a model must not
   * spend 90 seconds trying to reach `localhost:11434` on every request.
   */
  MODEL_PROVIDER: z.enum(['ollama', 'fake', 'none']).optional(),
  /** Where Ollama listens. Never leaves the server: `/model/health` does not echo it. */
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  /**
   * `gemma4:latest`, not the `gemma4:e4b` named in the original design docs: `e4b` is not
   * installed on the machine this project runs on and the M0 spike measured everything
   * against `latest` (8B, Q4_K_M). See "Findings from M0" in docs/07-open-decisions.md.
   */
  OLLAMA_CHAT_MODEL: z.string().min(1).default('gemma4:latest'),
  OLLAMA_EMBED_MODEL: z.string().min(1).default('nomic-embed-text'),
  /**
   * Per-call ceiling. 90 s is not generous, it is *measured*: warm calls take 6–45 s on
   * this hardware and a cold model load adds another 20–40 s (docs/spike-notes.md). A
   * 30-second timeout would fail most first calls of the day.
   */
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(90_000),
});

/** Treat an env var that is present but empty as absent: `KEY=` in a .env means "unset". */
const blankToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

const ConfigSchema = EnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.SESSION_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_SECRET'],
      message: 'is required in production (at least 32 characters) — run `pnpm setup:env`',
    });
  }

  const mfaKey = blankToUndefined(env.MFA_ENCRYPTION_KEY);
  if (env.NODE_ENV === 'production' && !mfaKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MFA_ENCRYPTION_KEY'],
      message: 'is required in production (32 bytes, hex or base64) — run `pnpm setup:env`',
    });
  } else if (mfaKey) {
    // Length is validated *here*, at boot, not at the first enrollment: a 16-byte key
    // pasted into the environment would otherwise sit there until someone tried to turn
    // MFA on and got a 500.
    try {
      decodeKeyMaterial(mfaKey);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MFA_ENCRYPTION_KEY'],
        message: error instanceof MfaKeyError ? error.message : 'is not a valid 32-byte key',
      });
    }
  }
}).transform((env) => ({
  ...env,
  SESSION_SECRET: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
  // `new URL(...).origin` normalises away a trailing slash and any path, so
  // `http://localhost:5173/` in a .env still compares equal to the browser's `Origin`.
  APP_ORIGIN: new URL(env.APP_ORIGIN).origin,
  COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
  MFA_ENCRYPTION_KEY: blankToUndefined(env.MFA_ENCRYPTION_KEY) ?? DEV_MFA_ENCRYPTION_KEY,
  // Dev gets the real model, production gets nothing unless it is told otherwise, and a
  // test that forgets to say which one it wants gets `none` rather than a socket.
  MODEL_PROVIDER: env.MODEL_PROVIDER ?? (env.NODE_ENV === 'development' ? 'ollama' : 'none'),
}));

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The MFA key as raw bytes. Decoded on demand rather than cached on the config object so
 * `Config` stays a plain, JSON-loggable shape (a `Buffer` in there would eventually end
 * up in a log line), and because this is called once per MFA request at most.
 */
export function mfaEncryptionKey(cfg: Config): Buffer {
  return decodeKeyMaterial(cfg.MFA_ENCRYPTION_KEY);
}

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
