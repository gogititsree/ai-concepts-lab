import { BACKUP_CODE_LOW_WATERMARK, classifyMfaCode } from '@lab/shared';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { Button, Eyebrow, Panel } from '../../components/ui';
import { Field, FormError, FormNote, SubmitButton } from '../../features/auth/formBits';
import { ApiError, authErrorMessage, useLogout, useMfaVerify } from '../../features/auth/mutations';
import { useAuth } from '../../features/auth/useAuth';

/**
 * Login step 2: the second factor.
 *
 * This screen only makes sense for a *pending* session — one that has cleared the
 * password step and nothing else. Anything else is a wrong turn and is redirected rather
 * than rendered: an anonymous visitor to `/login`, an already-signed-in one to wherever
 * they were going. That mirrors the API guard exactly, which is the point: the UI should
 * never show a form whose request is guaranteed to 401.
 *
 * One input takes both factors. Which one it is, is a property of the string
 * (`classifyMfaCode`, shared with the server), so nobody who has lost their phone has to
 * find the right tab before they can use a backup code.
 */
export function MfaPage() {
  const { status } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const verify = useMfaVerify();
  const logout = useLogout();

  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (status === 'loading') {
    return (
      <div className="py-16 text-center text-sm" role="status">
        Checking your session…
      </div>
    );
  }
  // The password step has not happened (or the 10-minute pending session expired).
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from }} />;
  // Already through both steps — nothing to verify.
  if (status === 'authenticated') return <Navigate to={from} replace />;

  const kind = classifyMfaCode(code);
  const formatError =
    touched && code.trim() !== '' && kind === 'unknown'
      ? 'Enter the 6-digit code from your app, or one of your backup codes.'
      : null;

  // The API reports how many tries are left in the error details, so the user is not
  // surprised by the sudden 429 that revokes their pending session.
  const attemptsRemaining =
    verify.error instanceof ApiError &&
    typeof (verify.error.details as { attemptsRemaining?: number } | undefined)
      ?.attemptsRemaining === 'number'
      ? (verify.error.details as { attemptsRemaining: number }).attemptsRemaining
      : null;
  const rateLimited = verify.error instanceof ApiError && verify.error.code === 'RATE_LIMITED';

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (kind === 'unknown') return;

    verify.mutate(
      { code: code.trim() },
      {
        onSuccess: (result) => {
          // A last warning before they leave the only screen that knows the number.
          if (
            result.usedBackupCode &&
            typeof result.remainingBackupCodes === 'number' &&
            result.remainingBackupCodes <= BACKUP_CODE_LOW_WATERMARK
          ) {
            void navigate('/settings/security', {
              replace: true,
              state: { lowBackupCodes: result.remainingBackupCodes },
            });
            return;
          }
          void navigate(from, { replace: true });
        },
      },
    );
  };

  return (
    <section className="mx-auto max-w-md py-10">
      <Eyebrow>Step 2 of 2</Eyebrow>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Two-factor verification</h1>
      <p className="text-muted mt-2 text-sm">
        Enter the 6-digit code from your authenticator app. Lost your phone? A backup code works
        here too.
      </p>

      <Panel className="mt-6 p-5">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {verify.isError && <FormError>{authErrorMessage(verify.error)}</FormError>}

          {rateLimited ? (
            <FormNote>
              That pending sign-in has been cancelled. Start again from the sign-in page.
            </FormNote>
          ) : (
            attemptsRemaining !== null && (
              <FormNote>
                {attemptsRemaining === 0
                  ? 'No attempts left — the next one cancels this sign-in.'
                  : `${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} left before this sign-in is cancelled.`}
              </FormNote>
            )
          )}

          <Field
            label="Code"
            name="code"
            // `one-time-code` is what lets iOS and Android offer the SMS/app code; the
            // input is deliberately not `type="number"`, which would mangle backup codes.
            autoComplete="one-time-code"
            inputMode={kind === 'backup' ? 'text' : 'numeric'}
            autoFocus
            spellCheck={false}
            placeholder="123456 or xxxxx-xxxxx"
            value={code}
            error={formatError}
            hint={
              kind === 'backup' ? 'Reading this as a backup code — it will be used up.' : undefined
            }
            onChange={(event) => setCode(event.target.value)}
          />

          <SubmitButton pending={verify.isPending} className="w-full">
            Verify
          </SubmitButton>
        </form>
      </Panel>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-muted text-xs">Codes are valid for about a minute either side of now.</p>
        {/* The escape hatch: without it, a pending session with no phone to hand is a
            dead end until the 10-minute expiry runs out. */}
        <Button
          variant="ghost"
          disabled={logout.isPending}
          onClick={() => logout.mutate(undefined, { onSuccess: () => void navigate('/login') })}
        >
          Sign out
        </Button>
      </div>
    </section>
  );
}
