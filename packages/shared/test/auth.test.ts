import { describe, expect, it } from 'vitest';

import {
  COMMON_PASSWORDS,
  EmailSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  MeResponseSchema,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PasswordChangeRequestSchema,
  PasswordSchema,
  PublicUserSchema,
  RegisterRequestSchema,
  SessionIdParamSchema,
  SessionSummarySchema,
  isCommonPassword,
} from '../src/auth.js';

const VALID_USER = {
  id: '3f6cd1a4-6a2f-4d2a-9d4e-1b2c3d4e5f60',
  email: 'learner@example.com',
  displayName: 'Learner',
  mfaEnabled: false,
  createdAt: '2025-01-01T00:00:00.000Z',
};

describe('password policy', () => {
  it('pins the documented bounds', () => {
    expect(PASSWORD_MIN).toBe(12);
    expect(PASSWORD_MAX).toBe(128);
  });

  it('accepts a passphrase and rejects one character less than the minimum', () => {
    expect(PasswordSchema.safeParse('a'.repeat(PASSWORD_MIN)).success).toBe(true);
    expect(PasswordSchema.safeParse('a'.repeat(PASSWORD_MIN - 1)).success).toBe(false);
  });

  it('imposes no composition rules', () => {
    // NIST SP 800-63B: no "must contain a digit and a symbol". Length is the control.
    expect(PasswordSchema.safeParse('all lowercase words here').success).toBe(true);
  });
});

describe('the common-password list', () => {
  it('bundles a substantial list, stored lowercase', () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThan(900);
    for (const entry of COMMON_PASSWORDS) {
      expect(entry).toBe(entry.toLowerCase());
      expect(entry.trim()).toBe(entry);
    }
  });

  it('catches the obvious guesses regardless of case or padding', () => {
    expect(isCommonPassword('password')).toBe(true);
    expect(isCommonPassword('QWERTY123456')).toBe(true);
    expect(isCommonPassword(' letmein123 ')).toBe(true);
  });

  it('leaves a real passphrase alone', () => {
    expect(isCommonPassword('correct horse battery staple')).toBe(false);
  });
});

describe('EmailSchema', () => {
  it('trims and validates', () => {
    expect(EmailSchema.parse('  learner@example.com ')).toBe('learner@example.com');
    expect(EmailSchema.safeParse('not-an-email').success).toBe(false);
  });
});

describe('RegisterRequestSchema', () => {
  it('accepts a well-formed body', () => {
    const parsed = RegisterRequestSchema.parse({
      email: 'learner@example.com',
      password: 'correct horse battery staple',
      displayName: '  Learner  ',
    });
    expect(parsed.displayName).toBe('Learner');
  });

  it('applies the full password policy', () => {
    const result = RegisterRequestSchema.safeParse({
      email: 'learner@example.com',
      password: 'password1234',
      displayName: 'Learner',
    });
    expect(result.success).toBe(false);
  });
});

describe('LoginRequestSchema', () => {
  it('does not apply the password policy', () => {
    // Deliberate: enforcing the policy at login would tell an attacker that no account
    // could have that password, and would lock out anyone whose password predates it.
    expect(LoginRequestSchema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(
      true,
    );
  });

  it('still requires both fields', () => {
    expect(LoginRequestSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });
});

describe('LoginResponseSchema', () => {
  it('accepts the ok variant', () => {
    expect(LoginResponseSchema.parse({ status: 'ok', user: VALID_USER })).toMatchObject({
      status: 'ok',
    });
  });

  it('accepts the mfa_required variant, which carries no user', () => {
    expect(LoginResponseSchema.parse({ status: 'mfa_required' })).toEqual({
      status: 'mfa_required',
    });
  });

  it('rejects an ok response with no user', () => {
    expect(LoginResponseSchema.safeParse({ status: 'ok' }).success).toBe(false);
  });
});

describe('PublicUserSchema', () => {
  it('strips anything that is not part of the public projection', () => {
    const parsed = PublicUserSchema.parse({
      ...VALID_USER,
      passwordHash: '$argon2id$v=19$m=65536,p=1,t=3$abc$def',
      failedLoginCount: 3,
      lockedUntil: null,
    });

    // This is the structural guarantee: even handed a whole database row, the schema can
    // only emit the five public fields.
    expect(Object.keys(parsed).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'id',
      'mfaEnabled',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('argon2');
  });
});

describe('MeResponseSchema', () => {
  it('carries the session state the SPA routes on', () => {
    const parsed = MeResponseSchema.parse({
      user: VALID_USER,
      session: { mfaVerified: false, expiresAt: '2025-01-08T00:00:00.000Z' },
    });
    expect(parsed.session.mfaVerified).toBe(false);
  });
});

describe('PasswordChangeRequestSchema', () => {
  it('requires the new password to differ from the current one', () => {
    const same = 'correct horse battery staple';
    const result = PasswordChangeRequestSchema.safeParse({
      currentPassword: same,
      newPassword: same,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['newPassword']);
  });

  it('applies the policy to the new password only', () => {
    expect(
      PasswordChangeRequestSchema.safeParse({
        currentPassword: 'short-legacy',
        newPassword: 'a brand new long passphrase',
      }).success,
    ).toBe(true);
  });
});

describe('session schemas', () => {
  it('requires an 8-character hex id in a summary', () => {
    const summary = {
      id: 'a1b2c3d4',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastSeenAt: '2025-01-01T00:05:00.000Z',
      expiresAt: '2025-01-08T00:00:00.000Z',
      ip: '127.0.0.1',
      userAgent: null,
      current: true,
    };
    expect(SessionSummarySchema.parse(summary)).toEqual(summary);
    expect(SessionSummarySchema.safeParse({ ...summary, id: 'A1B2C3D4' }).success).toBe(false);
  });

  it('accepts either an 8- or a 64-character id as a route parameter', () => {
    expect(SessionIdParamSchema.safeParse({ id: 'a1b2c3d4' }).success).toBe(true);
    expect(SessionIdParamSchema.safeParse({ id: 'ab'.repeat(32) }).success).toBe(true);
    expect(SessionIdParamSchema.safeParse({ id: 'abc' }).success).toBe(false);
    expect(SessionIdParamSchema.safeParse({ id: 'zzzzzzzz' }).success).toBe(false);
  });
});
