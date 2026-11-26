import { eq } from 'drizzle-orm';
import type { KeyEnv, KeyScope } from '@throttlebox/shared';
import { db } from '../db/client.js';
import { apiKeyFamilies, apiKeys } from '../db/schema.js';
import { recordFailureThrottled } from './audit.js';
import { getCachedKey, invalidateCachedKey, setCachedKey, type CachedKeyRow } from './cache.js';
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
 *   2. Redis-cached public_id lookup / DB    no row             → null
 *   3. family not revoked                    revoked family     → null
 *   4. status === 'active'                   revoked key        → null
 *   5. now < expires_at                      expired            → null
 *   6. now < grace_until (if set)            grace over         → null
 *   7. HMAC match (constant time)            wrong secret       → null
 *
 * Every failure returns the same `null`. Distinguishing "revoked" from
 * "expired" from "wrong" in the response would be a free oracle; the real
 * reason goes to the audit trail instead.
 */
export async function verifyKey(raw: string): Promise<AuthKeyContext | null> {
  // 1. Shape validation.
  const parsed = parseKey(raw);
  if (!parsed) return null;

  // 2. Redis-cached lookup before hitting Postgres.
  //
  // The cache holds lifecycle state only — never the secret hash. That keeps a
  // Redis compromise from yielding verifiable credential digests, and it means
  // the secret is always checked against the row read from the database.
  const cached = await getCachedKey(parsed.publicId);

  if (!cached) {
    const [dbRow] = await db
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

    if (!dbRow) {
      // Burn an equivalent HMAC so a miss costs the same as a hit and an
      // attacker cannot enumerate valid public ids by timing the response.
      const dummy = hashSecret(parsed.publicId, 'x'.repeat(SECRET_LENGTH));
      safeEqualHex(dummy, DUMMY_SECRET_HASH);
      return null;
    }

    const row: CachedKeyRow = {
      id: dbRow.id,
      orgId: dbRow.orgId,
      familyId: dbRow.familyId,
      env: dbRow.env,
      scopes: dbRow.scopes,
      status: dbRow.status,
      expiresAt: dbRow.expiresAt ? dbRow.expiresAt.toISOString() : null,
      graceUntil: dbRow.graceUntil ? dbRow.graceUntil.toISOString() : null,
      familyRevokedAt: dbRow.familyRevokedAt ? dbRow.familyRevokedAt.toISOString() : null,
    };

    await setCachedKey(parsed.publicId, row);

    return finishVerification(row, dbRow.secretHash, parsed);
  }

  // A cache hit still needs the digest to compare the secret against. Read it
  // from the database — an indexed lookup on `public_id`, which is what the
  // cache was saving; the lifecycle work below is unchanged.
  const [secretRow] = await db
    .select({ secretHash: apiKeys.secretHash })
    .from(apiKeys)
    .where(eq(apiKeys.publicId, parsed.publicId))
    .limit(1);

  if (!secretRow) {
    // Revoked and purged between the cache read and now.
    await invalidateCachedKey(parsed.publicId, false);
    return null;
  }

  return finishVerification(cached, secretRow.secretHash, parsed);
}

/**
 * Apply the lifecycle checks and compare the secret.
 *
 * Split out so the cache-hit and cache-miss paths share one implementation:
 * two copies of these rules is how one of them eventually drifts.
 */
async function finishVerification(
  row: CachedKeyRow,
  secretHash: string,
  parsed: { publicId: string; secret: string },
): Promise<AuthKeyContext | null> {
  const now = new Date();
  const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
  const graceUntil = row.graceUntil ? new Date(row.graceUntil) : null;
  const familyRevokedAt = row.familyRevokedAt ? new Date(row.familyRevokedAt) : null;
  const scopes = normalizeScopes(row.scopes);

  // 3. A revoked family kills every key in the chain.
  if (familyRevokedAt) {
    await fail(row, 'auth_failed', 'family_revoked');
    return null;
  }

  // 4. An individually revoked key is dead.
  if (row.status !== 'active') {
    await fail(row, 'auth_failed', 'key_revoked');
    return null;
  }

  // 5. Expiry.
  if (expiresAt && expiresAt <= now) {
    await fail(row, 'expired', 'key_expired');
    return null;
  }

  // 6. Grace window. A null grace_until means this is the current key.
  if (graceUntil && graceUntil <= now) {
    await fail(row, 'auth_failed', 'grace_elapsed');
    return null;
  }

  // 7. The secret itself.
  const computed = hashSecret(parsed.publicId, parsed.secret);
  if (!safeEqualHex(computed, secretHash)) {
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
  await recordFailureThrottled({
    keyId: row.id,
    familyId: row.familyId,
    orgId: row.orgId,
    event,
    metadata: { reason },
  });
}

/**
 * Build an auth context for a key identified by id, without its secret.
 *
 * Used only by the playground runner, which presents the per-process
 * internal token instead of the raw key (the raw key is never stored). Every
 * lifecycle check from `verifyKey` still applies — revoked family, revoked
 * key, expiry, elapsed grace window — and it reads the database directly
 * rather than the cache, so a revocation is honoured immediately.
 */
export async function loadKeyContextById(keyId: string): Promise<AuthKeyContext | null> {
  const [row] = await db
    .select({
      id: apiKeys.id,
      orgId: apiKeys.orgId,
      familyId: apiKeys.familyId,
      env: apiKeys.env,
      scopes: apiKeys.scopes,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
      graceUntil: apiKeys.graceUntil,
      familyRevokedAt: apiKeyFamilies.revokedAt,
    })
    .from(apiKeys)
    .innerJoin(apiKeyFamilies, eq(apiKeys.familyId, apiKeyFamilies.id))
    .where(eq(apiKeys.id, keyId))
    .limit(1);

  if (!row) return null;

  const now = new Date();
  if (row.familyRevokedAt) return null;
  if (row.status !== 'active') return null;
  if (row.expiresAt && row.expiresAt <= now) return null;
  if (row.graceUntil && row.graceUntil <= now) return null;

  touch(row.id);

  return {
    keyId: row.id,
    orgId: row.orgId,
    familyId: row.familyId,
    env: row.env,
    scopes: normalizeScopes(row.scopes),
  };
}
