import { and, eq } from 'drizzle-orm';
import type { KeyEnv, KeyScope } from '@throttlebox/shared';
import { db } from '../db/client.js';
import { apiKeyFamilies, apiKeys } from '../db/schema.js';
import { recordEventSafe } from './audit.js';
import { DUMMY_SECRET_HASH, hashSecret, safeEqualHex } from './generate.js';
import { parseKey, SECRET_LENGTH } from './format.js';
import { normalizeScopes } from './store.js';
import { touch } from './touch.js';

export interface AuthKeyContext {
  keyId: string;
  orgId: string;
  familyId: string;
  env: KeyEnv;
  scopes: KeyScope[];
}

/**
 * Verify a raw API key.
 *
 * Ordered, and every step fails closed:
 *
 *   1. parse and validate the shape          malformed          → null
 *   2. SELECT by public_id (unique index)    no row             → null
 *   3. family not revoked                    revoked family     → null
 *   4. status === 'active'                   revoked key        → null
 *   5. now < expires_at                      expired            → null
 *   6. now < grace_until (if set)            grace over         → null
 *   7. HMAC match (constant time)            wrong secret       → null
 *
 * Every failure returns the same `null`. Distinguishing "revoked" from
 * "expired" from "wrong" in the response would be a free oracle; the real
 * reason goes to the audit trail instead.
 *
 * This is the seam that Phase 4 replaces: a Redis-cached public id lookup
 * goes in front of step 2 and a sliding-window limiter goes after step 7.
 * Nothing above this function changes.
 */
export async function verifyKey(raw: string): Promise<AuthKeyContext | null> {
  // 1. Shape validation.
  const parsed = parseKey(raw);
  if (!parsed) return null;

  // 2. Indexed lookup.
  const [row] = await db
    .select({
      id: apiKeys.id,
      orgId: apiKeys.orgId,
      familyId: apiKeys.familyId,
      env: apiKeys.env,
      scopes: apiKeys.scopes,
      status: apiKeys.status,
      secretHash: apiKeys.secretHash,
      expiresAt: apiKeys.expiresAt,
      graceUntil: apiKeys.graceUntil,
      familyRevokedAt: apiKeyFamilies.revokedAt,
    })
    .from(apiKeys)
    .innerJoin(apiKeyFamilies, eq(apiKeys.familyId, apiKeyFamilies.id))
    .where(eq(apiKeys.publicId, parsed.publicId))
    .limit(1);

  if (!row) {
    // Burn an equivalent HMAC so a miss costs the same as a hit and an
    // attacker cannot enumerate valid public ids by timing the response.
    const dummy = hashSecret(parsed.publicId, 'x'.repeat(SECRET_LENGTH));
    safeEqualHex(dummy, DUMMY_SECRET_HASH);
    return null;
  }

  const now = new Date();
  const scopes = normalizeScopes(row.scopes);

  // 3. A revoked family kills every key in the chain.
  if (row.familyRevokedAt) {
    await fail(row, 'auth_failed', 'family_revoked');
    return null;
  }

  // 4. An individually revoked key is dead.
  if (row.status !== 'active') {
    await fail(row, 'auth_failed', 'key_revoked');
    return null;
  }

  // 5. Expiry.
  if (row.expiresAt && row.expiresAt <= now) {
    await fail(row, 'expired', 'key_expired');
    return null;
  }

  // 6. Grace window. A null grace_until means this is the current key.
  if (row.graceUntil && row.graceUntil <= now) {
    await fail(row, 'auth_failed', 'grace_elapsed');
    return null;
  }

  // 7. The secret itself.
  const computed = hashSecret(parsed.publicId, parsed.secret);
  if (!safeEqualHex(computed, row.secretHash)) {
    await fail(row, 'auth_failed', 'bad_secret');
    return null;
  }

  // Success. Record the usage without blocking the response.
  touch(row.id);

  return {
    keyId: row.id,
    orgId: row.orgId,
    familyId: row.familyId,
    env: row.env,
    scopes,
  };
}

/**
 * Record a failed authentication attempt.
 *
 * We can only attribute failures to an org when the public id resolved to a
 * row, so unknown keys are not logged here — see the note in `audit.ts`.
 */
async function fail(
  row: {
    id: string;
    orgId: string;
    familyId: string;
  },
  event: 'auth_failed' | 'expired',
  reason: string,
): Promise<void> {
  await recordEventSafe({
    keyId: row.id,
    familyId: row.familyId,
    orgId: row.orgId,
    event,
    metadata: { reason },
  });
}

/**
 * Look up a key by id without verifying a secret. Used by the dashboard to
 * show key details, never for authentication.
 */
export async function findKeyByPublicId(publicId: string) {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.publicId, publicId)))
    .limit(1);

  return row ?? null;
}
