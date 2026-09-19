import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { Eyebrow, Panel } from '../../components/ui';
import { Field, FormError, SubmitButton } from '../../features/auth/formBits';
import { authErrorMessage, useLogin } from '../../features/auth/mutations';

/**
 * Login step 1: the password.
 *
 * Two things make this more than a form. First, the response is a *discriminated union*
 * (`ok` or `mfa_required`), and which branch comes back decides where the browser goes —
 * the server, not the client, knows whether this account has a second factor. Second,
 * `location.state.from`: `RequireAuth` stashes the page the user was trying to reach, so
 * signing in returns them there instead of dumping them on the dashboard.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useLogin();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);

  // Where to land afterwards. Read once here and handed on to the MFA screen, so a
  // deep link survives both steps of the login.
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const emailError = touched && email.trim() === '' ? 'Enter your email address.' : null;
  const passwordError = touched && password === '' ? 'Enter your password.' : null;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (email.trim() === '' || password === '') return;

    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: (result) => {
          if (result.status === 'mfa_required') {
            // The cookie now holds a 10-minute pending session; the MFA screen is the
            // only place that can turn it into a real one.
            void navigate('/login/mfa', { replace: true, state: { from } });
            return;
          }
          void navigate(from, { replace: true });
        },
      },
    );
  };

  return (
    <section className="mx-auto max-w-md py-10">
      <Eyebrow>Concepts Lab</Eyebrow>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sign in</h1>
      <p className="text-muted mt-2 text-sm">
        Your progress, quiz attempts and agent runs are tied to your account.
      </p>

      <Panel className="mt-6 p-5">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {login.isError && <FormError>{authErrorMessage(login.error)}</FormError>}

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
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            error={passwordError}
            onChange={(event) => setPassword(event.target.value)}
          />

          <SubmitButton pending={login.isPending} className="w-full">
            Sign in
          </SubmitButton>
        </form>
      </Panel>

      <p className="text-muted mt-4 text-sm">
        No account yet?{' '}
        <Link to="/register" className="text-ink underline underline-offset-4">
          Create one
        </Link>
        .
      </p>
    </section>
  );
}
