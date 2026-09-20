import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import { isAppError } from '../lib/errors.js';

/**
 * One error shape for the whole API: `{ error: { code, message, details? } }`
 * (`docs/01-architecture.md` → Conventions).
 *
 * Two rules drive everything below:
 *
 *  - **Nothing unexpected reaches the client.** An `AppError` is something a handler
 *    chose to say; anything else is a bug, and bugs become an opaque 500. Stack traces,
 *    driver messages and SQL fragments are exactly the material an attacker wants.
 *  - **Everything unexpected reaches the logs.** The 500 carries the request id that is
 *    also on the response header, so a user can quote it and the line is one grep away.
 */

export interface ErrorPayload {
  error: { code: string; message: string; details?: unknown };
}

export interface MappedError {
  statusCode: number;
  body: ErrorPayload;
  /** True when the original error should be logged at error level (i.e. it is a bug). */
  isUnexpected: boolean;
}

/**
 * Fastify's own errors (bad JSON body, unsupported media type, payload too large) already
 * carry a sensible status; they just need this app's vocabulary for the `code` field.
 */
const STATUS_CODES: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  423: 'LOCKED',
  429: 'RATE_LIMITED',
};

/**
 * Node's socket-level codes for "nothing is listening / it went away". postgres.js
 * surfaces a refused connection as an `AggregateError` carrying `code: 'ECONNREFUSED'`
 * (one entry per address it tried), and drizzle wraps whatever it caught in a
 * `DrizzleQueryError` with the original on `cause` — so the check walks the cause chain
 * rather than looking at the top-level error only.
 */
const CONNECTION_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
]);

function isConnectionFailure(error: unknown, depth = 0): boolean {
  // Cause chains are short; the bound stops a self-referential one from hanging a request.
  if (depth > 5 || typeof error !== 'object' || error === null) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_FAILURE_CODES.has(code)) return true;

  // AggregateError from a multi-address connect: any leg refusing is the same outage.
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.some((entry) => isConnectionFailure(entry, depth + 1))) {
    return true;
  }

  return isConnectionFailure((error as { cause?: unknown }).cause, depth + 1);
}

/** The opaque 500 every unexpected failure collapses to. Frozen: callers only read it. */
const internalError: MappedError = Object.freeze({
  statusCode: 500,
  body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
  isUnexpected: true,
});

/**
 * Pure mapping from a thrown value to a status + body, so the whole table can be unit
 * tested without booting a server.
 */
export function mapError(error: unknown): MappedError {
  // A `throw 'boom'` is legal JavaScript and reaches here as a string. The library
  // predicates below use the `in` operator, which throws on a primitive, so anything
  // that is not an object is dealt with first.
  if (typeof error !== 'object' || error === null) return internalError;

  if (isAppError(error)) {
    return {
      statusCode: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      isUnexpected: error.statusCode >= 500,
    };
  }

  // Request validation failed against a Zod schema. `details` lists the offending fields
  // so a form can highlight them; it contains the client's own input shape, never ours.
  if (hasZodFastifySchemaValidationErrors(error)) {
    return {
      statusCode: 400,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: error.validation.map((entry) => ({
            path: entry.params.issue.path.join('.'),
            message: entry.params.issue.message,
            code: entry.params.issue.code,
          })),
        },
      },
      isUnexpected: false,
    };
  }

  // The *response* did not match its schema: always a server bug, and the details would
  // describe internal structure, so the client gets nothing.
  if (isResponseSerializationError(error)) return internalError;

  // The database is unreachable. Worth its own code rather than the opaque 500: this is
  // the single most common thing to go wrong in development (`pnpm db:up` not run, or
  // Docker restarted and the container did not come back), and "Internal server error"
  // sends you reading application code for a fault that is not in it.
  //
  // It is a dependency failure, not a bug, so 503 — and the message names the fix. The
  // same reasoning as `MODEL_UNAVAILABLE`, which already does this for Ollama.
  if (isConnectionFailure(error)) {
    return {
      statusCode: 503,
      body: {
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message:
            'The database is not reachable. In development, start it with `pnpm db:up`; see docs/runbooks/db-migration-failed.md if it is running.',
        },
      },
      // Not "unexpected": it is logged, but it is an outage, not a defect to chase.
      isUnexpected: false,
    };
  }

  const status = (error as FastifyError | undefined)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = error instanceof Error ? error.message : 'Request failed';
    return {
      statusCode: status,
      body: { error: { code: STATUS_CODES[status] ?? 'BAD_REQUEST', message } },
      isUnexpected: false,
    };
  }

  return internalError;
}

/**
 * Attaches the handler to the root instance (not via `register`, for the same
 * encapsulation reason as `plugins/csrf.ts`).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);

    if (mapped.isUnexpected) {
      request.log.error({ err: error, reqId: request.id }, 'unhandled error');
    } else {
      request.log.debug(
        { err: error, code: mapped.body.error.code },
        'request rejected with a handled error',
      );
    }

    // Re-asserted rather than assumed: an error thrown from an `onRequest` hook can land
    // here before the hook that normally sets it has run.
    reply.header('x-request-id', request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
}
