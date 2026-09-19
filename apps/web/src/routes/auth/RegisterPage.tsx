import { isCommonPassword, PASSWORD_MAX, PASSWORD_MIN } from '@lab/shared';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { Eyebrow, Panel } from '../../components/ui';
import { CheckItem, Field, FormError, SubmitButton } from '../../features/auth/formBits';
import { authErrorMessage, useRegister } from '../../features/auth/mutations';

/**
 * Registration, with the password policy shown as it is typed.
 *
 * The checklist runs the *same* two rules the API enforces — `PASSWORD_MIN`/`PASSWORD_MAX`
 * and `isCommonPassword`, both imported from `@lab/shared` — rather than a second copy
 * written in the browser's idiom. That is the whole point of the shared package: a policy
 * that lives in two places eventually disagrees with itself, and the failure mode is a
 * form that says "looks good" and then gets a 400.
 *
 * NIST SP 800-63B, as `docs/03-auth-mfa.md` records: length and a common-password list,
 * no composition rules, no forced symbols.
 */
export function RegisterPage() {
  const navigate = useNavigate();
  const register = useRegister();

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);

  const longEnough = password.length >= PASSWORD_MIN;
  const shortEnough = password.length <= PASSWORD_MAX;
  const notCommon = password.length > 0 && !isCommonPassword(password);
  const matches = password.length > 0 && password === confirm;
  const passwordOk = longEnough && shortEnough && notCommon;

  const emailError = touched && email.trim() === '' ? 'Enter your email address.' : null;
  const nameError = touched && displayName.trim() === '' ? 'Enter a display name.' : null;
  const confirmError = touched && !matches ? 'The two passwords do not match.' : null;

  const canSubmit = email.trim() !== '' && displayName.trim() !== '' && passwordOk && matches;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit) return;

    register.mutate(
      { email: email.trim(), password, displayName: displayName.trim() },
      // Register creates a full session (nobody has MFA on their first second), so there
      // is no second step to route through.
      { onSuccess: () => void navigate('/', { replace: true }) },
    );
  };

  return (
    <section className="mx-auto max-w-md py-10">
      <Eyebrow>Concepts Lab</Eyebrow>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Create an account</h1>
      <p className="text-muted mt-2 text-sm">
        One account, one learner. There is no email verification yet — a deliberate, documented
        tradeoff for a solo app.
      </p>

      <Panel className="mt-6 p-5">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {register.isError && <FormError>{authErrorMessage(register.error)}</FormError>}

          <Field
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            error={emailError}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Field
            label="Display name"
            name="displayName"
            autoComplete="nickname"
            value={displayName}
            error={nameError}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Field
            label="Password"
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          <ul className="space-y-1" data-testid="password-checklist" aria-live="polite">
            <CheckItem ok={longEnough}>At least {PASSWORD_MIN} characters</CheckItem>
            <CheckItem ok={shortEnough}>At most {PASSWORD_MAX} characters</CheckItem>
            <CheckItem ok={notCommon}>Not on the bundled common-password list</CheckItem>
            <CheckItem ok={matches}>Both fields match</CheckItem>
          </ul>

          <Field
            label="Confirm password"
            type="password"
            name="confirmPassword"
            autoComplete="new-password"
            value={confirm}
            error={confirmError}
            onChange={(event) => setConfirm(event.target.value)}
          />

          <SubmitButton pending={register.isPending} className="w-full">
            Create account
          </SubmitButton>
        </form>
      </Panel>

      <p className="text-muted mt-4 text-sm">
        Already have one?{' '}
        <Link to="/login" className="text-ink underline underline-offset-4">
          Sign in
        </Link>
        .
      </p>
    </section>
  );
}
