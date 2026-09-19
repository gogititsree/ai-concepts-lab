import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { useAuth } from './useAuth';

/**
 * Route guard mirroring the API's session guard (docs/03-auth-mfa.md): an anonymous visitor
 * goes to the login page, and a session that has passed the password step but still owes a
 * second factor goes to the MFA screen. Anything else would let the UI show a page whose
 * data requests are about to 401.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="py-16 text-center text-sm text-slate-500" role="status">
        Checking your session…
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (status === 'pending-mfa') {
    return (
      <Navigate to="/login/mfa" replace state={{ from: location.pathname + location.search }} />
    );
  }

  return <>{children}</>;
}

/**
 * The inverse guard: keeps a signed-in user off the login and register pages.
 */
export function RequireAnonymous({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="py-16 text-center text-sm text-slate-500" role="status">
        Checking your session…
      </div>
    );
  }
  if (status === 'authenticated') return <Navigate to="/" replace />;
  if (status === 'pending-mfa') return <Navigate to="/login/mfa" replace />;

  return <>{children}</>;
}
