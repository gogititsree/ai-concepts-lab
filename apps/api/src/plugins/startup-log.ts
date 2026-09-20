import type { FastifyInstance } from 'fastify';

import type { Config } from '../config.js';

/**
 * The first line a deploy writes: what this instance thinks it is.
 *
 * Every production incident starts with "which build, pointed at which database, with
 * which provider?", and the honest answer is the *effective* configuration — after
 * defaults, after coercion, after the `NODE_ENV`-dependent branches in `config.ts`. Not
 * what the dashboard says; what the process resolved. A deploy that came up with
 * `MODEL_PROVIDER=ollama` because a variable was misspelled, or against last month's
 * database because a copy-paste kept the old host, is a one-line diagnosis if this
 * exists and an afternoon if it does not.
 *
 * The rule that makes it safe to keep at `info`: **no secret is ever a value here.** A
 * secret appears only as the boolean fact that it is set. That is the useful half
 * anyway — "is `MFA_ENCRYPTION_KEY` present" answers a real question; its bytes answer
 * none — and it means these lines can be shipped to a log aggregator, pasted into an
 * issue, or read over someone's shoulder.
 */

/** What a secret is replaced with. Two spellings, so "set" and "absent" stay distinct. */
export const SECRET_SET = '[set]';
export const SECRET_UNSET = '[unset]';

export interface RedactedConfig {
  nodeEnv: string;
  version: string;
  host: string;
  port: number;
  logLevel: string;
  /** `host:port/database` — never the userinfo, which carries the password. */
  database: string;
  dbPoolMax: number;
  appOrigin: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  modelProvider: string;
  chatModel: string;
  embedModel: string;
  modelTimeoutMs: number;
  sessionSecret: string;
  mfaEncryptionKey: string;
  maintenanceToken: string;
  metricsToken: string;
}

/**
 * `postgres://user:hunter2@ep-x.neon.tech:5432/lab?sslmode=require` →
 * `ep-x.neon.tech:5432/lab`.
 *
 * The password is the obvious secret, but the username is dropped too: on Neon it is
 * half of a credential pair and it identifies the role, and neither fact helps anyone
 * reading a boot line. Host and database name are what "am I pointed at the right
 * place?" actually needs.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '') || '(default)';
    return `${parsed.host}/${database}`;
  } catch {
    // An unparseable URL must not leak by falling back to the raw string.
    return '(unparseable)';
  }
}

const presence = (value: string | undefined): string =>
  value === undefined || value === '' ? SECRET_UNSET : SECRET_SET;

/** The log-safe view of the configuration. Pure, so the redaction itself is testable. */
export function describeConfig(cfg: Config): RedactedConfig {
  return {
    nodeEnv: cfg.NODE_ENV,
    version: cfg.GIT_SHA,
    host: cfg.HOST,
    port: cfg.PORT,
    logLevel: cfg.LOG_LEVEL,
    database: redactDatabaseUrl(cfg.DATABASE_URL),
    dbPoolMax: cfg.DB_POOL_MAX,
    appOrigin: cfg.APP_ORIGIN,
    cookieSecure: cfg.COOKIE_SECURE,
    trustProxy: cfg.TRUST_PROXY,
    modelProvider: cfg.MODEL_PROVIDER,
    chatModel: cfg.OLLAMA_CHAT_MODEL,
    embedModel: cfg.OLLAMA_EMBED_MODEL,
    modelTimeoutMs: cfg.MODEL_TIMEOUT_MS,
    // The secrets, and the only form in which they may ever appear here. `SESSION_SECRET`
    // and `MFA_ENCRYPTION_KEY` always have a value by the time `Config` exists
    // (production refuses to boot without one; elsewhere a development fallback
    // applies), so there is no `[unset]` case to report for those two. The two bearer
    // tokens are genuinely optional, so their presence is real information.
    sessionSecret: SECRET_SET,
    mfaEncryptionKey: SECRET_SET,
    maintenanceToken: presence(cfg.MAINTENANCE_TOKEN),
    // M14's `/metrics` bearer token. Reported here for the same reason as the others:
    // "is observability switched on for this instance?" is a boot-time question.
    metricsToken: presence(cfg.METRICS_TOKEN),
  };
}

/**
 * Warnings worth one line each at boot, where the operator is actually looking. None of
 * them is fatal — each describes a configuration that is legitimate somewhere (the
 * Playwright suite runs `NODE_ENV=production` over plain http on purpose) but is almost
 * certainly a mistake on a public URL.
 */
export function configWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  if (cfg.NODE_ENV !== 'production') return warnings;

  if (!cfg.COOKIE_SECURE) {
    warnings.push(
      'COOKIE_SECURE is false in production: the session cookie will be sent over plain http',
    );
  }
  if (!cfg.TRUST_PROXY) {
    warnings.push(
      'TRUST_PROXY is false in production: behind Render every request appears to come ' +
        'from the proxy, so the per-IP rate limits share one bucket',
    );
  }
  if (!cfg.MAINTENANCE_TOKEN) {
    warnings.push(
      'MAINTENANCE_TOKEN is unset: POST /api/v1/ops/maintenance is disabled, so the ' +
        'scheduled session and run cleanup cannot run (see docs/runbooks/session-cleanup.md)',
    );
  }
  if (cfg.APP_ORIGIN.startsWith('http://')) {
    warnings.push(`APP_ORIGIN is not https (${cfg.APP_ORIGIN})`);
  }
  return warnings;
}

/** Emits the boot lines. Called from `buildApp`, so every entrypoint gets them. */
export function logEffectiveConfig(app: FastifyInstance, cfg: Config = app.config): void {
  app.log.info(describeConfig(cfg), 'effective configuration');
  for (const warning of configWarnings(cfg)) {
    app.log.warn(warning);
  }
}
