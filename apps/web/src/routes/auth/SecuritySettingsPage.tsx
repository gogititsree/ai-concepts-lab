import {
  BACKUP_CODE_LOW_WATERMARK,
  isCommonPassword,
  PASSWORD_MIN,
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  type MfaEnrollResponse,
} from '@lab/shared';
import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';

import { Button, Eyebrow, Panel } from '../../components/ui';
import { CheckItem, Field, FormError, FormNote, SubmitButton } from '../../features/auth/formBits';
import {
  authErrorMessage,
  useChangePassword,
  useDisableMfa,
  useMfaConfirm,
  useMfaEnroll,
  useRegenerateBackupCodes,
  useRevokeSession,
  useSessions,
} from '../../features/auth/mutations';
import { useAuth } from '../../features/auth/useAuth';

/**
 * Everything an account can do to itself: turn on a second factor, turn it off, mint new
 * backup codes, see where it is signed in, change its password.
 *
 * ## Rendering the QR code
 *
 * The server sends `qrSvg` — markup it generated itself with the `qrcode` package. Two
 * ways to put that on screen: `dangerouslySetInnerHTML`, or an `<img>` whose `src` is a
 * data URI. **This page uses the data URI.**
 *
 * The reason is not that the markup is untrusted — it is ours, built from a URI we also
 * built. It is that an `<img>` cannot execute anything *whatever* the bytes turn out to
 * be: SVG in an `<img>` is rendered in a sandbox with no script, no external fetches and
 * no access to the embedding document. `dangerouslySetInnerHTML` would inline the SVG
 * into the page's own DOM, where a `<script>` or an `onload` attribute — arriving through
 * a compromised dependency, a future change to the encoder, or a proxy that "helpfully"
 * rewrites responses — would run with full access to the session. The data URI costs one
 * base64 encode and removes the whole class of question, so there is nothing to audit
 * later.
 */

export function SecuritySettingsPage() {
  const { user, me } = useAuth();
  const location = useLocation();
  const lowFromLogin = (location.state as { lowBackupCodes?: number } | null)?.lowBackupCodes;

  const mfaEnabled = user?.mfaEnabled ?? false;
  const remaining = me?.remainingBackupCodes ?? null;

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-8">
      <header>
        <Eyebrow>Account</Eyebrow>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Security</h1>
        <p className="text-muted mt-2 text-sm">
          Signed in as <span className="readout">{user?.email}</span>.
        </p>
      </header>

      {typeof lowFromLogin === 'number' && (
        <FormNote>
          You signed in with a backup code and have {lowFromLogin} left. Generate a new set below
          before you run out.
        </FormNote>
      )}

      <MfaPanel enabled={mfaEnabled} remaining={remaining} />

      <SessionsPanel />
      <ChangePasswordPanel />
    </div>
  );
}

// ---------------------------------------------------------------- the MFA panel ----

/**
 * Enrollment, disable, regeneration and the status line, in **one** component.
 *
 * Splitting "off" and "on" into two components is the obvious factoring and it is wrong:
 * confirming enrollment flips `user.mfaEnabled` to true on the very next `/auth/me`,
 * which would unmount the off-state component — and with it the only copy of the backup
 * codes the user is ever shown. Keeping one component means the `codes` step survives the
 * status change, because the status is a prop and the step is state. (A test caught this:
 * the "Done" button vanished mid-assertion.)
 */
type Step = 'idle' | 'password' | 'scan' | 'codes' | 'regenerate' | 'disable';

function MfaPanel({ enabled, remaining }: { enabled: boolean; remaining: number | null }) {
  const enroll = useMfaEnroll();
  const confirm = useMfaConfirm();
  const regenerate = useRegenerateBackupCodes();
  const disable = useDisableMfa();

  const [step, setStep] = useState<Step>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const reset = (): void => {
    setStep('idle');
    setPassword('');
    setCode('');
    setEnrollment(null);
    setBackupCodes(null);
    setAcknowledged(false);
    enroll.reset();
    confirm.reset();
    regenerate.reset();
    disable.reset();
  };

  const submitPassword = (event: FormEvent): void => {
    event.preventDefault();
    if (password === '') return;
    enroll.mutate(
      { password },
      {
        onSuccess: (result) => {
          setEnrollment(result);
          setPassword('');
          setStep('scan');
        },
      },
    );
  };

  const submitCode = (event: FormEvent): void => {
    event.preventDefault();
    const digits = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) return;
    confirm.mutate(
      { code: digits },
      {
        onSuccess: (result) => {
          setBackupCodes(result.backupCodes);
          setCode('');
          setAcknowledged(false);
          setStep('codes');
        },
      },
    );
  };

  const submitRegenerate = (event: FormEvent): void => {
    event.preventDefault();
    regenerate.mutate(
      { password, code: code.trim() },
      {
        onSuccess: (result) => {
          setBackupCodes(result.backupCodes);
          setPassword('');
          setCode('');
          setAcknowledged(false);
          setStep('codes');
        },
      },
    );
  };

  const submitDisable = (event: FormEvent): void => {
    event.preventDefault();
    disable.mutate({ password, code: code.trim() }, { onSuccess: reset });
  };

  const low = enabled && remaining !== null && remaining <= BACKUP_CODE_LOW_WATERMARK;

  return (
    <Panel className="p-5" data-testid="mfa-panel">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <Eyebrow>Two-factor authentication</Eyebrow>
          <p className="mt-1 text-lg font-semibold">{enabled ? 'On' : 'Off'}</p>
        </div>
        <span className="readout text-muted text-xs">
          {enabled && remaining !== null ? `${remaining} backup codes left` : 'TOTP · RFC 6238'}
        </span>
      </div>

      {low && step !== 'codes' && (
        <div className="mt-3">
          <FormNote>
            Only {remaining} backup code{remaining === 1 ? '' : 's'} left. Generate a new set now
            &mdash; the old ones stop working the moment you do.
          </FormNote>
        </div>
      )}

      {step === 'idle' && !enabled && (
        <>
          <p className="text-muted mt-3 text-sm">
            A second factor means a stolen password is not enough. You will need an authenticator
            app (Aegis, 1Password, Google Authenticator &mdash; anything that speaks {TOTP_DIGITS}
            -digit, {TOTP_PERIOD_SECONDS}-second TOTP).
          </p>
          <Button variant="primary" className="mt-4" onClick={() => setStep('password')}>
            Set up two-factor
          </Button>
        </>
      )}

      {step === 'idle' && enabled && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => setStep('regenerate')}>Generate new backup codes</Button>
          <Button onClick={() => setStep('disable')}>Turn off two-factor</Button>
        </div>
      )}

      {step === 'password' && (
        <form onSubmit={submitPassword} noValidate className="mt-4 space-y-4">
          <p className="text-muted text-sm">
            Step 1 of 3. Confirm your password &mdash; a valid session alone should not be able to
            change how the account is protected.
          </p>
          {enroll.isError && <FormError>{authErrorMessage(enroll.error)}</FormError>}
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="flex gap-2">
            <SubmitButton pending={enroll.isPending}>Continue</SubmitButton>
            <Button onClick={reset}>Cancel</Button>
          </div>
        </form>
      )}

      {step === 'scan' && enrollment && (
        <div className="mt-4 space-y-4">
          <p className="text-muted text-sm">
            Step 2 of 3. Scan this with your authenticator app, then type the code it shows.
          </p>

          <div className="flex flex-wrap items-start gap-5">
            <img
              // See the file header: an <img> data URI cannot execute anything, whatever
              // the SVG turns out to contain.
              src={svgToDataUri(enrollment.qrSvg)}
              alt={`QR code enrolling ${TOTP_ISSUER} in your authenticator app`}
              data-testid="mfa-qr"
              className="border-rule bg-surface h-44 w-44 rounded-md border p-2"
            />
            <div className="min-w-[14rem] flex-1">
              <Eyebrow>Can&rsquo;t scan? Type this in</Eyebrow>
              <p
                className="readout bg-sunk border-rule mt-1 rounded-md border px-2 py-2 text-sm break-all"
                data-testid="manual-secret"
              >
                {groupSecret(enrollment.secretForManualEntry)}
              </p>
              <p className="text-muted mt-2 text-xs">
                Account <span className="readout">{TOTP_ISSUER}</span>, SHA-1, {TOTP_DIGITS} digits,{' '}
                {TOTP_PERIOD_SECONDS} s. This is the only time the secret is shown.
              </p>
              <CopyButton value={enrollment.secretForManualEntry} label="Copy secret" />
            </div>
          </div>

          <form onSubmit={submitCode} noValidate className="space-y-3">
            {confirm.isError && <FormError>{authErrorMessage(confirm.error)}</FormError>}
            <Field
              label="Code from your app"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <div className="flex gap-2">
              <SubmitButton pending={confirm.isPending}>Turn on two-factor</SubmitButton>
              <Button onClick={reset}>Cancel</Button>
            </div>
          </form>
        </div>
      )}

      {step === 'codes' && backupCodes && (
        <div className="mt-4 space-y-4" data-testid="backup-codes-step">
          <p className="text-sm">
            Two-factor is <strong>on</strong>. Save these backup codes: they are shown once, each
            works once, and they are the only way in if you lose your phone.
          </p>
          <BackupCodeSheet codes={backupCodes} />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-ink mt-0.5"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>I have saved these codes somewhere safe. They will not be shown again.</span>
          </label>
          {/* The gate: there is no second chance to read them, so "Done" stays dead until
              the user says they have saved them. */}
          <Button variant="primary" disabled={!acknowledged} onClick={reset}>
            Done
          </Button>
        </div>
      )}

      {step === 'regenerate' && (
        <StepUpForm
          title="Generate new backup codes"
          warning="Your current backup codes stop working immediately."
          submitLabel="Generate new codes"
          pending={regenerate.isPending}
          error={regenerate.isError ? authErrorMessage(regenerate.error) : null}
          password={password}
          code={code}
          onPassword={setPassword}
          onCode={setCode}
          onSubmit={submitRegenerate}
          onCancel={reset}
        />
      )}

      {step === 'disable' && (
        <StepUpForm
          title="Turn off two-factor"
          warning="Your authenticator secret and all backup codes are deleted. A password alone will sign you in again."
          submitLabel="Turn it off"
          pending={disable.isPending}
          error={disable.isError ? authErrorMessage(disable.error) : null}
          password={password}
          code={code}
          onPassword={setPassword}
          onCode={setCode}
          onSubmit={submitDisable}
          onCancel={reset}
        />
      )}
    </Panel>
  );
}

/** Password + current code. Shared by disable and regenerate, which take the same proof. */
function StepUpForm(props: {
  title: string;
  warning: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  password: string;
  code: string;
  onPassword: (value: string) => void;
  onCode: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <form onSubmit={props.onSubmit} noValidate className="mt-4 space-y-4">
      <p className="text-sm font-medium">{props.title}</p>
      <FormNote>{props.warning}</FormNote>

      {!confirmed ? (
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setConfirmed(true)}>
            I understand, continue
          </Button>
          <Button onClick={props.onCancel}>Cancel</Button>
        </div>
      ) : (
        <>
          {props.error && <FormError>{props.error}</FormError>}
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={props.password}
            onChange={(event) => props.onPassword(event.target.value)}
          />
          <Field
            label="Code from your app (or a backup code)"
            autoComplete="one-time-code"
            placeholder="123456"
            value={props.code}
            onChange={(event) => props.onCode(event.target.value)}
          />
          <div className="flex gap-2">
            <SubmitButton pending={props.pending}>{props.submitLabel}</SubmitButton>
            <Button onClick={props.onCancel}>Cancel</Button>
          </div>
        </>
      )}
    </form>
  );
}

// ----------------------------------------------------------------- backup codes ----

function BackupCodeSheet({ codes }: { codes: string[] }) {
  const text = codes.join('\n');
  return (
    <div className="border-rule bg-sunk rounded-md border p-4">
      <ul className="readout grid grid-cols-2 gap-x-6 gap-y-1 text-sm" data-testid="backup-codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton value={text} label="Copy all" />
        <Button onClick={() => downloadText('concepts-lab-backup-codes.txt', text)}>
          Download as .txt
        </Button>
      </div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      className="mt-2"
      onClick={() => {
        // `navigator.clipboard` is absent in insecure contexts and in jsdom; the button
        // reports what actually happened rather than lying with a checkmark.
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

// --------------------------------------------------------------------- sessions ----

function SessionsPanel() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const [pendingId, setPendingId] = useState<string | null>(null);

  return (
    <Panel className="p-5" data-testid="sessions-panel">
      <Eyebrow>Where you are signed in</Eyebrow>
      {sessions.isPending && <p className="text-muted mt-3 text-sm">Loading…</p>}
      {sessions.isError && <FormError>{authErrorMessage(sessions.error)}</FormError>}

      {sessions.data && (
        <ul className="mt-3 divide-y divide-[var(--rule)]">
          {sessions.data.sessions.map((session) => (
            <li key={session.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="readout text-sm">
                  {session.id}
                  {session.current && (
                    <span className="text-muted ml-2 text-xs">· this device</span>
                  )}
                </p>
                <p className="text-muted truncate text-xs">
                  {session.ip ?? 'unknown address'} &middot; {session.userAgent ?? 'unknown client'}
                </p>
                <p className="text-muted text-xs">
                  last seen {new Date(session.lastSeenAt).toLocaleString()}
                </p>
              </div>
              {pendingId === session.id ? (
                <span className="flex shrink-0 gap-2">
                  <Button
                    variant="primary"
                    disabled={revoke.isPending}
                    onClick={() =>
                      revoke.mutate(session.id, { onSettled: () => setPendingId(null) })
                    }
                  >
                    Confirm
                  </Button>
                  <Button onClick={() => setPendingId(null)}>Cancel</Button>
                </span>
              ) : (
                <Button className="shrink-0" onClick={() => setPendingId(session.id)}>
                  {session.current ? 'Sign out here' : 'Revoke'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// -------------------------------------------------------------- change password ----

function ChangePasswordPanel() {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);

  const longEnough = next.length >= PASSWORD_MIN;
  const notCommon = next.length > 0 && !isCommonPassword(next);
  const matches = next.length > 0 && next === confirm;
  const different = next !== current;
  const canSubmit = current !== '' && longEnough && notCommon && matches && different;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setConfirm('');
          setDone(true);
        },
      },
    );
  };

  return (
    <Panel className="p-5" data-testid="password-panel">
      <Eyebrow>Password</Eyebrow>
      <p className="text-muted mt-1 text-sm">
        Changing it signs out every other device. This one stays signed in.
      </p>

      <form onSubmit={onSubmit} noValidate className="mt-4 space-y-4">
        {change.isError && <FormError>{authErrorMessage(change.error)}</FormError>}
        {done && !change.isError && <FormNote>Password changed.</FormNote>}

        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
            setDone(false);
          }}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        <ul className="space-y-1">
          <CheckItem ok={longEnough}>At least {PASSWORD_MIN} characters</CheckItem>
          <CheckItem ok={notCommon}>Not a common password</CheckItem>
          <CheckItem ok={matches}>Both fields match</CheckItem>
          <CheckItem ok={next.length > 0 && different}>Different from the current one</CheckItem>
        </ul>
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <SubmitButton pending={change.isPending} disabled={!canSubmit}>
          Change password
        </SubmitButton>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------- helpers ----

/**
 * Base64 data URI for an SVG string. Hand-rolled rather than `btoa(svg)` because `btoa`
 * throws on any code point above U+00FF, and the encoder is free to emit one.
 */
function svgToDataUri(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** `ABCDEFGH…` → `ABCD EFGH …`, because 32 unbroken characters are unreadable. */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(' ');
}

function downloadText(filename: string, text: string): void {
  // Guarded: jsdom has no createObjectURL, and a missing download must not take the page
  // down in the one moment the codes are on screen.
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
