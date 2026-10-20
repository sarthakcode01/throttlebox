import { db } from '../db/client.js';
import { apiKeyEvents } from '../db/schema.js';

export const API_KEY_EVENTS = [
  'created',
  'rotated',
  'revoked',
  'family_revoked',
  'auth_failed',
  'expired',
] as const;

export type ApiKeyEventType = (typeof API_KEY_EVENTS)[number];

export interface RecordEventInput {
  keyId?: string | null | undefined;
  familyId?: string | null | undefined;
  orgId: string;
  /** The user who performed the action. Null when the key itself acted. */
  actorUserId?: string | null | undefined;
  event: ApiKeyEventType;
  ip?: string | undefined;
  userAgent?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Append to the API key audit trail.
 *
 * The table is append-only and never updated, so it stays a faithful history
 * even if a key is later revoked.
 *
 * Note on `auth_failed`: we only write that event when we can attribute the
 * failure to an org — that is, when the public id resolved to a row and a
 * later check (revoked, expired, bad secret) rejected it. An unknown public id
 * has no org, and `api_key_events.org_id` is NOT NULL by design. Writing a row
 * per unknown-key attempt would also turn the audit table into a write
 * amplifier for an unauthenticated attacker.
 */
export async function recordEvent(input: RecordEventInput): Promise<void> {
  await db.insert(apiKeyEvents).values({
    keyId: input.keyId ?? null,
    familyId: input.familyId ?? null,
    orgId: input.orgId,
    actorUserId: input.actorUserId ?? null,
    event: input.event,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    metadata: input.metadata ?? {},
  });
}

/**
 * Record an audit event without letting a failure break the request path.
 *
 * Used on the authentication hot path, where losing an audit row is far less
 * bad than failing the request itself.
 */
export async function recordEventSafe(input: RecordEventInput): Promise<void> {
  try {
    await recordEvent(input);
  } catch {
    // Intentionally swallowed — see the note on `auth_failed` above.
  }
}
