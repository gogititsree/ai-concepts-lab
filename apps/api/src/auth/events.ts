import { isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';

import type { Db } from '../db/client.js';
import { authEvents, type authEventType } from '../db/schema.js';

/**
 * The append-only audit log (`auth_events`).
 *
 * Every interesting thing that happens to a credential gets a row: who, what, from where,
 * when. This is the table you read during an incident ("was anyone else logging in as me
 * last Tuesday?"), and the one the lockout logic is explained by. Rule from
 * `docs/02-schema.md`: `metadata` never contains a password, token or code — only
 * classifications like `{reason:'bad_password'}`.
 */

export type AuthEventType = (typeof authEventType.enumValues)[number];

export interface AuthEventInput {
  /** NULL for a failed login against an email that does not exist. */
  userId?: string | null;
  eventType: AuthEventType;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Postgres `inet` rejects anything that is not an address, so an unusable value (a unix
 * socket path, a proxy header with a port glued on) must become NULL rather than take
 * down the insert — and with it the login it was recording.
 */
export function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null;
  return isIP(value) === 0 ? null : value;
}

/** User-Agent strings are attacker-controlled and unbounded; the column is not. */
const USER_AGENT_MAX = 512;

export function normaliseUserAgent(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, USER_AGENT_MAX);
}

/** Pulls the client identity off a request, normalised for the `inet`/`text` columns. */
export function requestOrigin(request: FastifyRequest): {
  ip: string | null;
  userAgent: string | null;
} {
  return {
    // `request.ip` is the socket address unless `TRUST_PROXY` is on, in which case it is
    // the left-most X-Forwarded-For entry Fastify trusts.
    ip: normaliseIp(request.ip),
    userAgent: normaliseUserAgent(request.headers['user-agent']),
  };
}

export async function recordAuthEvent(db: Db, input: AuthEventInput): Promise<void> {
  await db.insert(authEvents).values({
    userId: input.userId ?? null,
    eventType: input.eventType,
    ip: normaliseIp(input.ip),
    userAgent: normaliseUserAgent(input.userAgent),
    metadata: input.metadata ?? {},
  });
}
