import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from '../src/routes/auth/LoginPage';
import { MfaPage } from '../src/routes/auth/MfaPage';
import { RegisterPage } from '../src/routes/auth/RegisterPage';
import { SecuritySettingsPage } from '../src/routes/auth/SecuritySettingsPage';
import { renderWithProviders } from './harness';

/**
 * The four auth screens, driven through a stubbed `fetch`.
 *
 * No real API: the point of these tests is the *client* state machine — which response
 * sends the browser where, what the form refuses to submit, what the wizard gates. The
 * server's own behaviour is pinned by `apps/api/test/integration/mfa.test.ts` against a
 * real Postgres, and duplicating it here with mocks would only prove that the mocks
 * match the mocks.
 *
 * Navigation is asserted by rendering a small route table and looking for the page that
 * should have appeared. That is deliberately end-to-end within the client: a test that
 * spied on `useNavigate` would pass even if the route did not exist.
 */

const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'learner@example.test',
  displayName: 'Learner',
  mfaEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

type Handler = (body: unknown) => { status: number; body?: unknown };

/** method + path -> response. Anything unrouted fails loudly rather than 404-ing quietly. */
let routes: Record<string, Handler>;
let calls: Array<{ key: string; body: unknown }>;

function route(key: string, handler: Handler): void {
  routes[key] = handler;
}

const json = (body: unknown, status = 200): { status: number; body: unknown } => ({
  status,
  body,
});

const apiError = (status: number, code: string, message = code, details?: unknown) => ({
  status,
  body: { error: { code, message, details } },
});

/** `GET /auth/me` for each of the three states the screens care about. */
const meAnonymous = () => route('GET /auth/me', () => apiError(401, 'UNAUTHENTICATED'));
const mePending = (user = USER) =>
  route('GET /auth/me', () =>
    json({
      user: { ...user, mfaEnabled: true },
      session: { mfaVerified: false, expiresAt: '2026-01-01T00:10:00.000Z' },
      remainingBackupCodes: 10,
    }),
  );
const meAuthenticated = (overrides: Partial<typeof USER> = {}, remaining: number | null = null) =>
  route('GET /auth/me', () =>
    json({
      user: { ...USER, ...overrides },
      session: { mfaVerified: true, expiresAt: '2026-02-01T00:00:00.000Z' },
      remainingBackupCodes: remaining,
    }),
  );

beforeEach(() => {
  routes = {};
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ key, body });

      const handler = routes[key];
      if (!handler) throw new Error(`Unstubbed request: ${key}`);
      const result = handler(body);
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The route table the auth screens navigate within, plus markers for the destinations. */
function AuthRoutes() {
  return (
    <Routes>
      <Route path="/" element={<p>Dashboard</p>} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/login/mfa" element={<MfaPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/settings/security" element={<SecuritySettingsPage />} />
    </Routes>
  );
}

const renderAt = (path: string) => renderWithProviders(<AuthRoutes />, { path });

/**
 * Types into a field, waiting for it to exist.
 *
 * The wait is not incidental: every screen here renders a "checking your session"
 * placeholder until `GET /auth/me` settles, so a synchronous `getByLabelText` would race
 * the very redirect logic these tests are about.
 */
const type = async (label: RegExp, value: string, scope?: HTMLElement): Promise<void> => {
  const query = scope ? within(scope) : screen;
  const field = await query.findByLabelText(label);
  fireEvent.change(field, { target: { value } });
};

// ------------------------------------------------------------------------ login ----

describe('LoginPage', () => {
  it('signs in and lands on the page the guard came from', async () => {
    meAnonymous();
    route('POST /auth/login', () => json({ status: 'ok', user: USER }));

    renderAt('/login');
    await type(/^email$/i, USER.email);
    await type(/^password$/i, 'correct horse battery staple');
    // After a successful login /auth/me is refetched, and by then there is a session.
    meAuthenticated();
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(calls.map((call) => call.key)).toContain('POST /auth/login');
    expect(calls.find((call) => call.key === 'POST /auth/login')?.body).toEqual({
      email: USER.email,
      password: 'correct horse battery staple',
    });
  });

  it('routes to the second-factor screen on mfa_required', async () => {
    meAnonymous();
    route('POST /auth/login', () => json({ status: 'mfa_required' }));

    renderAt('/login');
    await type(/^email$/i, USER.email);
    await type(/^password$/i, 'correct horse battery staple');
    // The cookie now holds a pending session, so /auth/me answers as one.
    mePending();
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(
      await screen.findByRole('heading', { name: /two-factor verification/i }),
    ).toBeInTheDocument();
  });

  it.each([
    ['INVALID_CREDENTIALS', 401, /invalid email or password/i],
    ['LOCKED', 423, /locked/i],
    ['RATE_LIMITED', 429, /too many attempts/i],
  ])('shows the server error for %s', async (code, status, expected) => {
    meAnonymous();
    route('POST /auth/login', () => apiError(status, code));

    renderAt('/login');
    await type(/^email$/i, USER.email);
    await type(/^password$/i, 'whatever it takes');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByTestId('form-error')).toHaveTextContent(expected);
  });

  it('validates the fields before it makes a request', async () => {
    meAnonymous();
    renderAt('/login');

    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/enter your email address/i)).toBeInTheDocument();
    expect(screen.getByText(/enter your password/i)).toBeInTheDocument();
    expect(calls.some((call) => call.key === 'POST /auth/login')).toBe(false);
  });

  it('links to registration', async () => {
    meAnonymous();
    renderAt('/login');
    expect(await screen.findByRole('link', { name: /create one/i })).toHaveAttribute(
      'href',
      '/register',
    );
  });
});

// --------------------------------------------------------------------- register ----

describe('RegisterPage', () => {
  it('reacts to the password as it is typed', async () => {
    meAnonymous();
    renderAt('/register');

    const checklist = await screen.findByTestId('password-checklist');
    const items = () => Array.from(checklist.querySelectorAll('li'));

    // Nothing typed: length and "not common" both unmet.
    expect(items().map((item) => item.dataset.ok)).toEqual(['false', 'true', 'false', 'false']);

    await type(/^password$/i, 'short');
    expect(items()[0]?.dataset.ok).toBe('false');

    // On the bundled common list, and long enough — so length passes, commonness fails.
    await type(/^password$/i, 'password1234');
    expect(items()[0]?.dataset.ok).toBe('true');
    expect(items()[2]?.dataset.ok).toBe('false');

    await type(/^password$/i, 'correct horse battery staple');
    expect(items()[0]?.dataset.ok).toBe('true');
    expect(items()[2]?.dataset.ok).toBe('true');
    // Confirm field still empty.
    expect(items()[3]?.dataset.ok).toBe('false');

    await type(/confirm password/i, 'correct horse battery staple');
    expect(items()[3]?.dataset.ok).toBe('true');
  });

  it('registers and lands on the dashboard', async () => {
    meAnonymous();
    route('POST /auth/register', () => json({ user: USER }, 201));

    renderAt('/register');
    await type(/^email$/i, USER.email);
    await type(/display name/i, 'Learner');
    await type(/^password$/i, 'correct horse battery staple');
    await type(/confirm password/i, 'correct horse battery staple');
    meAuthenticated();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('will not submit a password that fails the shared policy', async () => {
    meAnonymous();
    renderAt('/register');

    await type(/^email$/i, USER.email);
    await type(/display name/i, 'Learner');
    await type(/^password$/i, 'password1234');
    await type(/confirm password/i, 'password1234');
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.key === 'POST /auth/register')).toBe(false);
    });
  });
});

// -------------------------------------------------------------------- MFA screen ----

describe('MfaPage', () => {
  it('verifies a TOTP and continues', async () => {
    mePending();
    route('POST /auth/mfa/verify', () =>
      json({ status: 'ok', user: { ...USER, mfaEnabled: true }, remainingBackupCodes: 10 }),
    );

    renderAt('/login/mfa');
    await type(/^code$/i, '123456');
    meAuthenticated({ mfaEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('turns an anonymous visitor away to the sign-in page', async () => {
    meAnonymous();
    renderAt('/login/mfa');
    expect(await screen.findByRole('heading', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('turns an already-verified session away to where it was going', async () => {
    meAuthenticated();
    renderAt('/login/mfa');
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('reports how many attempts are left, and refuses malformed input locally', async () => {
    mePending();
    route('POST /auth/mfa/verify', () =>
      apiError(401, 'INVALID_CODE', 'That code is not valid', { attemptsRemaining: 2 }),
    );

    renderAt('/login/mfa');
    // Neither six digits nor a backup code: rejected without a request.
    await type(/^code$/i, 'nope');
    fireEvent.click(await screen.findByRole('button', { name: /^verify$/i }));
    expect(await screen.findByText(/6-digit code from your app/i)).toBeInTheDocument();
    expect(calls.some((call) => call.key === 'POST /auth/mfa/verify')).toBe(false);

    await type(/^code$/i, '000000');
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));
    expect(await screen.findByText(/2 attempts left/i)).toBeInTheDocument();
  });

  it('recognises a backup code and says it will be spent', async () => {
    mePending();
    renderAt('/login/mfa');
    await type(/^code$/i, '9k3xq-m7b2t');
    expect(await screen.findByText(/reading this as a backup code/i)).toBeInTheDocument();
  });
});

// ------------------------------------------------------------- security settings ----

describe('SecuritySettingsPage enrollment wizard', () => {
  const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"></svg>';
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const CODES = Array.from({ length: 10 }, (_, index) => `aaaa${index}-bbbb${index}`);

  beforeEach(() => {
    meAuthenticated();
    route('GET /auth/sessions', () =>
      json({
        sessions: [
          {
            id: '9f2c1a08',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-01T00:05:00.000Z',
            expiresAt: '2026-02-01T00:00:00.000Z',
            ip: '127.0.0.1',
            userAgent: 'vitest',
            current: true,
          },
        ],
      }),
    );
  });

  it('walks password → QR → code → backup codes, and gates the last step', async () => {
    route('POST /auth/mfa/enroll', () =>
      json({
        otpauthUri: `otpauth://totp/AI%20Concepts%20Lab:${USER.email}?secret=${SECRET}`,
        qrSvg: QR_SVG,
        secretForManualEntry: SECRET,
      }),
    );
    route('POST /auth/mfa/confirm', () => json({ backupCodes: CODES }));

    renderAt('/settings/security');

    // Scoped to the MFA panel throughout: the change-password form further down the page
    // also has a "Current password" field, and an unscoped query would find both.
    const panel = await screen.findByTestId('mfa-panel');

    // Step 0: the invitation.
    fireEvent.click(within(panel).getByRole('button', { name: /set up two-factor/i }));

    // Step 1: the password step-up.
    await type(/current password/i, 'correct horse battery staple', panel);
    fireEvent.click(within(panel).getByRole('button', { name: /continue/i }));

    // Step 2: the QR, rendered as an <img> data URI (never injected into the DOM).
    const qr = await screen.findByTestId('mfa-qr');
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(qr.tagName).toBe('IMG');
    // The manual-entry secret is shown in readable groups.
    expect(screen.getByTestId('manual-secret').textContent?.replace(/\s/g, '')).toBe(SECRET);

    await type(/code from your app/i, '123456', panel);
    meAuthenticated({ mfaEnabled: true }, 10);
    fireEvent.click(within(panel).getByRole('button', { name: /turn on two-factor/i }));

    // Step 3: the codes, once.
    const sheet = await screen.findByTestId('backup-codes');
    expect(sheet.querySelectorAll('li')).toHaveLength(10);
    expect(sheet).toHaveTextContent(CODES[0] as string);

    // The acknowledgement gate: "Done" is dead until the box is ticked.
    const done = within(panel).getByRole('button', { name: /^done$/i });
    expect(done).toBeDisabled();
    fireEvent.click(within(panel).getByRole('checkbox'));
    expect(done).toBeEnabled();

    fireEvent.click(done);
    // Leaving the wizard does not show them again: the panel is back to its status view.
    await waitFor(() => expect(screen.queryByTestId('backup-codes')).not.toBeInTheDocument());
  });

  it('surfaces a wrong password at the step-up without advancing', async () => {
    route('POST /auth/mfa/enroll', () =>
      apiError(403, 'INVALID_CREDENTIALS', 'Current password is incorrect'),
    );

    renderAt('/settings/security');
    const panel = await screen.findByTestId('mfa-panel');
    fireEvent.click(within(panel).getByRole('button', { name: /set up two-factor/i }));
    await type(/current password/i, 'wrong', panel);
    fireEvent.click(within(panel).getByRole('button', { name: /continue/i }));

    expect(await within(panel).findByTestId('form-error')).toHaveTextContent(
      /invalid email or password/i,
    );
    expect(screen.queryByTestId('mfa-qr')).not.toBeInTheDocument();
  });

  it('shows the enabled state, the remaining count and a confirmation before disabling', async () => {
    meAuthenticated({ mfaEnabled: true }, 2);
    renderAt('/settings/security');

    // The panel renders before `/auth/me` settles, so wait for the loaded state rather
    // than asserting against the first paint.
    const panel = await screen.findByTestId('mfa-panel');
    await waitFor(() => expect(panel).toHaveTextContent('2 backup codes left'));
    expect(panel).toHaveTextContent('On');
    // At or below the watermark, the page nags.
    expect(panel).toHaveTextContent(/only 2 backup codes left/i);

    fireEvent.click(within(panel).getByRole('button', { name: /turn off two-factor/i }));
    // Destructive: the consequence is stated and confirmed before any credential is asked for.
    expect(within(panel).getByText(/all backup codes are deleted/i)).toBeInTheDocument();
    expect(within(panel).queryByLabelText(/current password/i)).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: /i understand, continue/i }));
    expect(within(panel).getByLabelText(/current password/i)).toBeInTheDocument();
  });

  it('lists sessions, marks this device and confirms a revoke', async () => {
    meAuthenticated({ mfaEnabled: true }, 10);
    route('DELETE /auth/sessions/9f2c1a08', () => ({ status: 204 }));

    renderAt('/settings/security');
    const panel = await screen.findByTestId('sessions-panel');
    await waitFor(() => expect(panel).toHaveTextContent('9f2c1a08'));
    expect(panel).toHaveTextContent('this device');

    fireEvent.click(within(panel).getByRole('button', { name: /sign out here/i }));
    // Nothing has been sent yet: revoking is two clicks.
    expect(calls.some((call) => call.key.startsWith('DELETE'))).toBe(false);

    fireEvent.click(within(panel).getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => {
      expect(calls.some((call) => call.key === 'DELETE /auth/sessions/9f2c1a08')).toBe(true);
    });
  });
});

/**
 * The two panels below the wizard.
 *
 * Both were entirely untested — 13 of `SecuritySettingsPage`'s 36 functions were
 * unreached and these accounted for most of them — and both are credential flows, which
 * is the last place to accept "it is probably fine". The server side is pinned by
 * `apps/api/test/integration/auth.test.ts`; what is checked here is the client's own
 * refusal to send, which the server never sees.
 */
describe('SecuritySettingsPage, the rest of the page', () => {
  beforeEach(() => {
    route('GET /auth/sessions', () => json({ sessions: [] }));
  });

  it('will not send a password change until every rule on screen is green', async () => {
    meAuthenticated();
    route('PATCH /auth/password', () => ({ status: 204 }));

    renderAt('/settings/security');
    const panel = await screen.findByTestId('password-panel');
    const submit = within(panel).getByRole('button', { name: /change password/i });

    // Too short.
    await type(/current password/i, 'correct horse battery staple', panel);
    await type(/^new password$/i, 'short', panel);
    await type(/confirm new password/i, 'short', panel);
    expect(submit).toBeDisabled();

    // Long enough, but the two fields disagree.
    await type(/^new password$/i, 'a much longer passphrase', panel);
    expect(submit).toBeDisabled();

    // Long enough and matching, but identical to the current one: changing a password to
    // itself is the failure this check exists for, and the server would accept it.
    await type(/^new password$/i, 'correct horse battery staple', panel);
    await type(/confirm new password/i, 'correct horse battery staple', panel);
    expect(submit).toBeDisabled();

    await type(/^new password$/i, 'a much longer passphrase', panel);
    await type(/confirm new password/i, 'a much longer passphrase', panel);
    expect(submit).toBeEnabled();
    // Nothing has left the browser through any of that.
    expect(calls.some((call) => call.key === 'PATCH /auth/password')).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => {
      expect(calls.find((call) => call.key === 'PATCH /auth/password')?.body).toEqual({
        currentPassword: 'correct horse battery staple',
        newPassword: 'a much longer passphrase',
      });
    });
    // The fields are emptied, so the new password is not left sitting in the DOM.
    await within(panel).findByText(/password changed/i);
    expect(within(panel).getByLabelText(/^new password$/i)).toHaveValue('');
  });

  it('reports a rejected password change and keeps the form usable', async () => {
    meAuthenticated();
    route('PATCH /auth/password', () =>
      apiError(403, 'INVALID_CREDENTIALS', 'Current password is incorrect'),
    );

    renderAt('/settings/security');
    const panel = await screen.findByTestId('password-panel');
    await type(/current password/i, 'wrong password here', panel);
    await type(/^new password$/i, 'a much longer passphrase', panel);
    await type(/confirm new password/i, 'a much longer passphrase', panel);
    fireEvent.click(within(panel).getByRole('button', { name: /change password/i }));

    expect(await within(panel).findByTestId('form-error')).toBeInTheDocument();
    expect(within(panel).queryByText(/password changed/i)).not.toBeInTheDocument();
    // Still on the form with the typed values intact: an error that clears the fields
    // makes the user retype a passphrase they got right.
    expect(within(panel).getByLabelText(/^new password$/i)).toHaveValue('a much longer passphrase');
  });

  it('regenerates backup codes behind a step-up and shows the new sheet once', async () => {
    const NEW_CODES = Array.from({ length: 10 }, (_, index) => `cccc${index}-dddd${index}`);
    meAuthenticated({ mfaEnabled: true }, 1);
    route('POST /auth/mfa/backup-codes/regenerate', () => json({ backupCodes: NEW_CODES }));

    renderAt('/settings/security');
    const panel = await screen.findByTestId('mfa-panel');
    await waitFor(() => expect(panel).toHaveTextContent('1 backup code'));

    fireEvent.click(within(panel).getByRole('button', { name: /generate new backup codes/i }));
    // Destructive, so it says so before asking for anything.
    expect(within(panel).getByText(/stop working immediately/i)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: /i understand, continue/i }));

    await type(/current password/i, 'correct horse battery staple', panel);
    await type(/code from your app/i, '123456', panel);
    fireEvent.click(within(panel).getByRole('button', { name: /generate new codes/i }));

    const sheet = await screen.findByTestId('backup-codes');
    expect(sheet.querySelectorAll('li')).toHaveLength(10);
    expect(sheet).toHaveTextContent(NEW_CODES[0] as string);
    expect(
      calls.find((call) => call.key === 'POST /auth/mfa/backup-codes/regenerate')?.body,
    ).toEqual({ password: 'correct horse battery staple', code: '123456' });

    // Same gate as enrollment: these are shown exactly once.
    const done = within(panel).getByRole('button', { name: /^done$/i });
    expect(done).toBeDisabled();
    fireEvent.click(within(panel).getByRole('checkbox'));
    fireEvent.click(done);
    await waitFor(() => expect(screen.queryByTestId('backup-codes')).not.toBeInTheDocument());
  });
});
