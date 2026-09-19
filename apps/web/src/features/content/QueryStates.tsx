import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { Button, Eyebrow, Panel } from '../../components/ui';
import { ApiError } from '../../lib/apiClient';

/**
 * The three things every content page has to be able to say, in one place so they say it
 * the same way.
 *
 * The middle one is the interesting one. The module pages are *not* wrapped in
 * `<RequireAuth>`: `App.tsx` is frozen for this milestone, and redirecting a reader to a
 * login form the moment they click a lesson would be a worse app anyway. So an
 * `UNAUTHENTICATED` response is rendered as a friendly panel with a link, in place, and
 * the rest of the page keeps whatever it can show without a session.
 */

export function LoadingPanel({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="readout text-muted py-10 text-center text-sm" role="status">
      {label}
    </p>
  );
}

export function SignInPanel({
  what = 'track your progress',
  className = '',
}: {
  what?: string;
  className?: string;
}) {
  return (
    <Panel className={`p-6 text-center ${className}`} data-testid="sign-in-panel">
      <Eyebrow>Signed out</Eyebrow>
      <p className="mt-2 text-lg font-medium">Sign in to {what}</p>
      <p className="text-muted mx-auto mt-2 max-w-sm text-sm leading-6">
        Lessons, exercises and quizzes live in the database now, and every one of them is tied to an
        account so your progress follows you between browsers.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link
          to="/login"
          className="readout border-ink bg-ink text-paper inline-flex rounded-md border px-3 py-1.5 text-xs font-medium hover:opacity-90"
        >
          Sign in
        </Link>
        <Link
          to="/register"
          className="readout border-rule bg-surface hover:bg-sunk inline-flex rounded-md border px-3 py-1.5 text-xs font-medium"
        >
          Create an account
        </Link>
      </div>
    </Panel>
  );
}

export function ErrorPanel({
  error,
  onRetry,
  className = '',
}: {
  error: Error;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <Panel className={`p-6 ${className}`} role="alert" data-testid="error-panel">
      <Eyebrow>Something went wrong</Eyebrow>
      <p className="mt-2 text-sm leading-6">
        {error.message || 'The request failed.'}
        {error instanceof ApiError && error.code !== 'UNKNOWN' && (
          <span className="text-muted readout ml-2 text-xs">({error.code})</span>
        )}
      </p>
      {onRetry && (
        <div className="mt-4">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </Panel>
  );
}

export interface QueryLike {
  isPending: boolean;
  error: Error | null;
  refetch: () => unknown;
}

/**
 * The fallback a page should render *instead of* its content, or `null` when the data is
 * there. A plain function rather than a component so a page can `return` it early
 * without introducing a conditional hook.
 */
export function queryFallback(
  query: QueryLike,
  options: { label?: string; signInFor?: string } = {},
): ReactElement | null {
  if (query.isPending) return <LoadingPanel label={options.label} />;
  if (query.error) {
    if (query.error instanceof ApiError && query.error.isUnauthenticated) {
      return <SignInPanel what={options.signInFor} />;
    }
    return (
      <ErrorPanel
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return null;
}

/** True when this failure is "you are not signed in" rather than a fault. */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.isUnauthenticated;
}
