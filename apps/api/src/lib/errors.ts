/**
 * The one error type route code throws.
 *
 * Fastify's default error shape is `{statusCode, error, message}`; this app's contract is
 * `{error:{code,message,details?}}` (see `docs/01-architecture.md` → Conventions). Rather
 * than building that object in twenty handlers, handlers throw an `AppError` and
 * `plugins/error-handler.ts` renders it. Anything that is *not* an `AppError` is by
 * definition a bug, and the handler turns it into an opaque 500.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** No session cookie, or one that is unknown, revoked or expired. */
export const unauthenticated = (message = 'Authentication required'): AppError =>
  new AppError(401, 'UNAUTHENTICATED', message);

/**
 * The session is real but has not cleared its second factor. Deliberately distinct from
 * `UNAUTHENTICATED`: the SPA sends this one to `/login/mfa`, not to `/login`.
 */
export const mfaRequired = (message = 'Multi-factor authentication required'): AppError =>
  new AppError(401, 'MFA_REQUIRED', message);

/**
 * Login failure. One code and one message for "no such email" and "wrong password"
 * alike — the whole point is that the response cannot be used to enumerate accounts.
 */
export const invalidCredentials = (): AppError =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

export const accountLocked = (retryAfterSeconds: number): AppError =>
  new AppError(
    423,
    'LOCKED',
    'Too many failed attempts; this account is temporarily locked. Try again later.',
    { retryAfterSeconds },
  );

export const notFound = (message = 'Not found'): AppError =>
  new AppError(404, 'NOT_FOUND', message);

export const rateLimited = (message = 'Too many requests'): AppError =>
  new AppError(429, 'RATE_LIMITED', message);
