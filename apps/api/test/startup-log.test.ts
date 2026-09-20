import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  configWarnings,
  describeConfig,
  redactDatabaseUrl,
  SECRET_SET,
  SECRET_UNSET,
} from '../src/plugins/startup-log.js';

/**
 * The boot line, and the one property that makes it safe to keep at `info`.
 *
 * Distinctive, unmistakable values are used for every secret below, so the "no secret
 * leaked" assertion is a real search rather than a coincidence: `lab` would match the
 * database name, `true` would match a flag.
 */

const SESSION = 'session-secret-SHOULD-NEVER-BE-LOGGED-aaaaaaaa';
const MFA_KEY = Buffer.from('mfa-key-SHOULD-NEVER-BE-LOGGED!!').toString('base64');
const DB_PASSWORD = 'db-password-SHOULD-NEVER-BE-LOGGED';
const MAINTENANCE = 'maintenance-token-SHOULD-NEVER-BE-LOGGED';

function config(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({
    NODE_ENV: 'production',
    GIT_SHA: 'abc1234',
    DATABASE_URL: `postgresql://neondb_owner:${DB_PASSWORD}@ep-x-123-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require`,
    SESSION_SECRET: SESSION,
    MFA_ENCRYPTION_KEY: MFA_KEY,
    MAINTENANCE_TOKEN: MAINTENANCE,
    APP_ORIGIN: 'https://ai-concepts-lab.onrender.com',
    COOKIE_SECURE: 'true',
    TRUST_PROXY: 'true',
    MODEL_PROVIDER: 'none',
    ...overrides,
  });
}

describe('redactDatabaseUrl', () => {
  it('keeps the host and database and drops the credentials', () => {
    expect(
      redactDatabaseUrl('postgresql://neondb_owner:hunter2@ep-x-pooler.aws.neon.tech/neondb'),
    ).toBe('ep-x-pooler.aws.neon.tech/neondb');
  });

  it('does not fall back to the raw string when the URL will not parse', () => {
    expect(redactDatabaseUrl('this is not a url')).toBe('(unparseable)');
  });
});

describe('describeConfig', () => {
  it('reports what the instance thinks it is', () => {
    const described = describeConfig(config());

    expect(described.nodeEnv).toBe('production');
    expect(described.version).toBe('abc1234');
    expect(described.database).toBe('ep-x-123-pooler.eu-central-1.aws.neon.tech/neondb');
    expect(described.appOrigin).toBe('https://ai-concepts-lab.onrender.com');
    expect(described.modelProvider).toBe('none');
    expect(described.cookieSecure).toBe(true);
  });

  it('contains no secret value anywhere in the serialised line', () => {
    // The assertion the whole file exists for. Serialised the way pino would, then
    // searched for each secret verbatim.
    const line = JSON.stringify(describeConfig(config()));

    for (const secret of [SESSION, MFA_KEY, DB_PASSWORD, MAINTENANCE]) {
      expect(line).not.toContain(secret);
    }
    // And the secrets are still *reported*, as presence.
    expect(line).toContain(SECRET_SET);
  });

  it('distinguishes an unset maintenance token from a set one', () => {
    expect(describeConfig(config({ MAINTENANCE_TOKEN: undefined })).maintenanceToken).toBe(
      SECRET_UNSET,
    );
    expect(describeConfig(config()).maintenanceToken).toBe(SECRET_SET);
  });
});

describe('configWarnings', () => {
  it('says nothing outside production, where every one of these is normal', () => {
    expect(
      configWarnings(
        loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://lab:lab@localhost/lab' }),
      ),
    ).toEqual([]);
  });

  it('is silent on a correctly configured production instance', () => {
    expect(configWarnings(config())).toEqual([]);
  });

  it('flags the configurations that are legitimate only in a test harness', () => {
    const warnings = configWarnings(
      config({ COOKIE_SECURE: 'false', TRUST_PROXY: 'false', MAINTENANCE_TOKEN: undefined }),
    ).join('\n');

    expect(warnings).toContain('COOKIE_SECURE');
    expect(warnings).toContain('TRUST_PROXY');
    expect(warnings).toContain('MAINTENANCE_TOKEN');
  });
});

describe('what refuses to boot in production', () => {
  /**
   * Each of these used to be survivable — the process would start with a wrong-but-
   * working value and fail later, somewhere unrelated. That is the failure mode M13 is
   * about, so each one is now a boot error with a sentence in it.
   */
  const cases: [string, Record<string, string | undefined>, string][] = [
    ['SESSION_SECRET missing', { SESSION_SECRET: undefined }, 'SESSION_SECRET'],
    ['MFA_ENCRYPTION_KEY missing', { MFA_ENCRYPTION_KEY: undefined }, 'MFA_ENCRYPTION_KEY'],
    ['APP_ORIGIN missing', { APP_ORIGIN: undefined }, 'APP_ORIGIN'],
    ['DATABASE_URL missing', { DATABASE_URL: undefined }, 'DATABASE_URL'],
    ['MFA_ENCRYPTION_KEY the wrong length', { MFA_ENCRYPTION_KEY: 'c2hvcnQ=' }, '32'],
    ['SESSION_SECRET too short', { SESSION_SECRET: 'short' }, '32'],
    ['MAINTENANCE_TOKEN too short', { MAINTENANCE_TOKEN: 'short' }, '32'],
  ];

  it.each(cases)('refuses to boot: %s', (_name, overrides, expected) => {
    expect(() => config(overrides)).toThrowError(new RegExp(expected));
  });

  it('names every problem at once rather than one per restart', () => {
    let message = '';
    try {
      config({ SESSION_SECRET: undefined, MFA_ENCRYPTION_KEY: undefined, APP_ORIGIN: undefined });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Three missing variables, one restart to find out about all three.
    expect(message).toContain('SESSION_SECRET');
    expect(message).toContain('MFA_ENCRYPTION_KEY');
    expect(message).toContain('APP_ORIGIN');
  });

  /**
   * The deploy workflow polls `/health` until `version` equals the commit it shipped,
   * so `GIT_SHA` reaching the process is not cosmetic: get it wrong and every deploy
   * times out after five minutes with the app running perfectly.
   */
  describe('GIT_SHA provenance', () => {
    const base = { DATABASE_URL: 'postgres://lab:lab@localhost/lab' };

    it('uses the build arg CI bakes into the image', () => {
      expect(loadConfig({ ...base, GIT_SHA: 'abc123' }).GIT_SHA).toBe('abc123');
    });

    it("falls back to Render's RENDER_GIT_COMMIT when there was no build arg", () => {
      // The Dockerfile sets `ENV GIT_SHA=${GIT_SHA}` with an empty default, so the
      // variable is present and empty — not absent. `??` would have kept the empty
      // string and this fallback would never have fired.
      expect(loadConfig({ ...base, GIT_SHA: '', RENDER_GIT_COMMIT: 'def456' }).GIT_SHA).toBe(
        'def456',
      );
      expect(loadConfig({ ...base, RENDER_GIT_COMMIT: 'def456' }).GIT_SHA).toBe('def456');
    });

    it("reports 'dev' when neither is set", () => {
      expect(loadConfig({ ...base, GIT_SHA: '' }).GIT_SHA).toBe('dev');
    });
  });

  it('still defaults APP_ORIGIN to the Vite dev server outside production', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://lab:lab@localhost/lab',
    });
    expect(cfg.APP_ORIGIN).toBe('http://localhost:5173');
  });
});

describe('the line the app actually emits at boot', () => {
  /**
   * The test above checks the redaction function; this one checks the thing that
   * reaches the log, through the real `buildApp` → pino path. They are not the same
   * assertion: a future change that logs `cfg` somewhere else, or that pino serialises
   * differently, would pass the first and fail this one.
   */
  // 30 s, not the 5 s default: this is the only test in the file that stands up the whole
  // Fastify app, which takes ~2.3 s alone and more when the suite runs in parallel on a
  // loaded machine. It was passing with about half the default budget to spare, which is
  // not a margin -- it is a CI failure waiting for a slower runner.
  it(
    'logs the effective configuration with no secret in it',
    { timeout: 30_000 },
    async () => {
      const lines: string[] = [];

      const app = await buildApp({
        config: config(),
        webDistPath: '/nonexistent',
        logger: {
          level: 'info',
          // pino writes newline-delimited JSON to whatever stream it is handed.
          stream: {
            write(chunk: string) {
              lines.push(chunk);
            },
          },
        },
      });
      await app.close();

      const bootLine = lines.find((line) => line.includes('effective configuration'));
      expect(bootLine, 'no "effective configuration" line was emitted').toBeDefined();

      for (const secret of [SESSION, MFA_KEY, DB_PASSWORD, MAINTENANCE]) {
        expect(bootLine).not.toContain(secret);
      }
      // ...and the whole log, not just that one line, in case something else logs cfg.
      for (const secret of [SESSION, MFA_KEY, DB_PASSWORD, MAINTENANCE]) {
        expect(lines.join('\n')).not.toContain(secret);
      }

      expect(bootLine).toContain('"nodeEnv":"production"');
      expect(bootLine).toContain('"sessionSecret":"[set]"');
      // Building a real Fastify instance is the slow part (a few seconds cold), and the
      // default 5 s vitest timeout is not enough when the suite is under load.
    },
    30_000,
  );
});
