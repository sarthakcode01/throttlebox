import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import {
  DEFAULT_KEY_SCOPE,
  KEY_SCOPES,
  type ApiKeySummary,
  type KeyEnv,
  type KeyScope,
} from '@throttlebox/shared';
import { db } from '../db/client.js';
import { apiKeyFamilies, apiKeys } from '../db/schema.js';
import { recordEvent } from './audit.js';
import { generateKeyMaterial, hashSecret } from './generate.js';
import {
  forgetMissingKey,
  invalidateCachedKey,
  invalidateFamilyKeyCache,
  invalidateKeys,
} from './cache.js';

/** How long a superseded key keeps working after a rotation. */
export const DEFAULT_GRACE_HOURS = 24;
/** Upper bound on a key's lifetime, so a key can never be effectively permanent by accident. */
export const MAX_EXPIRY_DAYS = 365;

export interface CreateKeyInput {
  orgId: string;
  name: string;
  env: KeyEnv;
  scopes?: KeyScope[] | undefined;
  /** Days until expiry. Null or undefined means it never expires. */
  expiresInDays?: number | null | undefined;
  /**
   * Client-supplied idempotency token. A repeated token is rejected rather
   * than minting a second key, because the raw key cannot be replayed on a
   * retry — it is only ever shown once.
   */
  idempotencyKey?: string | null | undefined;
  createdBy: string;
  actorUserId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface StoredKeyResult {
  id: string;
  familyId: string;
  /** The raw key. Returned exactly once, then never retrievable. */
  key: string;
  prefix: string;
  last4: string;
  env: KeyEnv;
  scopes: KeyScope[];
  expiresAt: Date | null;
}

export interface RotateKeyInput {
  orgId: string;
  keyId: string;
  /** Grace window for the old key. Defaults to 24h. */
  graceHours?: number | undefined;
  /** New scopes. Must be a superset of the old key's scopes. */
  scopes?: KeyScope[] | undefined;
  actorUserId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export class KeyStoreError extends Error {
  constructor(
    public code:
      | 'not_found'
      | 'already_revoked'
      | 'invalid_scopes'
      | 'invalid_grace'
      | 'invalid_expiry'
      | 'duplicate_idempotency_key',
    message: string,
  ) {
    super(message);
    this.name = 'KeyStoreError';
  }
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * Coerce a stored scope list into a valid one.
 *
 * An empty scope list means `mock:read` and nothing else. "Empty means all"
 * would be the dangerous default, so we never do it.
 */
export function normalizeScopes(raw: readonly string[] | undefined | null): KeyScope[] {
  if (!raw || raw.length === 0) return [DEFAULT_KEY_SCOPE];

  const valid = KEY_SCOPES.filter((scope) => raw.includes(scope));
  return valid.length > 0 ? valid : [DEFAULT_KEY_SCOPE];
}

/** Every scope in `next` must already exist in `previous` — scopes are additive. */
function isSuperset(next: readonly KeyScope[], previous: readonly KeyScope[]): boolean {
  return previous.every((scope) => next.includes(scope));
}

function toSummary(row: typeof apiKeys.$inferSelect): ApiKeySummary {
  return {
    id: row.id,
    familyId: row.familyId,
    name: row.name,
    display: `${row.prefix}…${row.last4}`,
    env: row.env,
    status: row.status,
    scopes: normalizeScopes(row.scopes),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    graceUntil: row.graceUntil ? row.graceUntil.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Create a key and its rotation family.
 *
 * Every key starts life in a fresh family. Rotation later mints the successor
 * inside that same family, which is what makes a family-wide kill switch
 * possible.
 */
export async function createKey(input: CreateKeyInput): Promise<StoredKeyResult> {
  const scopes = normalizeScopes(input.scopes);

  let expiresAt: Date | null = null;
  if (input.expiresInDays != null) {
    const days = Math.floor(input.expiresInDays);
    if (days < 1 || days > MAX_EXPIRY_DAYS) {
      throw new KeyStoreError('invalid_expiry', `expiresInDays must be 1–${MAX_EXPIRY_DAYS}`);
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const material = generateKeyMaterial(input.env);
  const secretHash = hashSecret(material.publicId, material.secret);

  let result: { id: string; familyId: string; expiresAt: Date | null };

  try {
    result = await db.transaction(async (tx) => {
      const [family] = await tx
        .insert(apiKeyFamilies)
        .values({ orgId: input.orgId, label: input.name })
        .returning({ id: apiKeyFamilies.id });

      if (!family) throw new Error('Failed to create key family');

      const [row] = await tx
        .insert(apiKeys)
        .values({
          orgId: input.orgId,
          familyId: family.id,
          name: input.name,
          publicId: material.publicId,
          prefix: material.prefix,
          secretHash,
          last4: material.last4,
          env: input.env,
          scopes,
          status: 'active',
          expiresAt,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: input.createdBy,
        })
        .returning({
          id: apiKeys.id,
          familyId: apiKeys.familyId,
          expiresAt: apiKeys.expiresAt,
        });

      if (!row) throw new Error('Failed to create api key');

      return row;
    });
  } catch (err) {
    // A repeated idempotency token means the client retried a create. We
    // cannot hand back the original key — it was only ever shown once — so we
    // reject instead of silently minting a second key.
    const code = (err as { code?: string }).code;
    if (code === UNIQUE_VIOLATION && input.idempotencyKey) {
      throw new KeyStoreError(
        'duplicate_idempotency_key',
        'A key was already created with this Idempotency-Key. It cannot be shown again — rotate it instead.',
      );
    }
    throw err;
  }

  await recordEvent({
    keyId: result.id,
    familyId: result.familyId,
    orgId: input.orgId,
    actorUserId: input.actorUserId ?? input.createdBy,
    event: 'created',
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { name: input.name, env: input.env, scopes },
  });

  await forgetMissingKey(material.publicId);

  return {
    id: result.id,
    familyId: result.familyId,
    key: material.key,
    prefix: material.prefix,
    last4: material.last4,
    env: input.env,
    scopes,
    expiresAt: result.expiresAt,
  };
}

/** All keys for an org, newest first. Secrets are never returned. */
export async function listKeys(orgId: string): Promise<ApiKeySummary[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.orgId, orgId))
    .orderBy(desc(apiKeys.createdAt));

  return rows.map(toSummary);
}

/** One key by id, scoped to its org. */
export async function getKey(orgId: string, keyId: string): Promise<ApiKeySummary | null> {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
    .limit(1);

  return row ? toSummary(row) : null;
}

/**
 * Rotate a key: mint a successor in the same family and let the old one keep
 * working for a grace window, so a deployment can swap keys without downtime.
 *
 * Scopes are additive over a key's lifetime. Narrowing them requires
 * rotating onto a key that already carries the wider set, so we reject a
 * rotation that would drop a scope the old key had.
 */
export async function rotateKey(input: RotateKeyInput): Promise<StoredKeyResult> {
  const graceHours = input.graceHours ?? DEFAULT_GRACE_HOURS;
  if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 24 * 30) {
    throw new KeyStoreError('invalid_grace', 'graceHours must be between 0 and 720');
  }

  const graceUntil = new Date(Date.now() + graceHours * 60 * 60 * 1000);

  const { result, existing, scopes, retiredPublicIds, key } = await db.transaction(async (tx) => {
    // Lock the family first. Two concurrent rotations used to each mint a
    // successor and each retire "every current key except mine" — but
    // neither could see the other's uncommitted successor, so the family
    // ended up with two current keys. Serialising on the family row makes
    // the second rotation see the first one's result.
    const [target] = await tx
      .select({ familyId: apiKeys.familyId })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.orgId, input.orgId)))
      .limit(1);

    if (!target) {
      throw new KeyStoreError('not_found', 'API key not found');
    }

    await tx
      .select({ id: apiKeyFamilies.id })
      .from(apiKeyFamilies)
      .where(eq(apiKeyFamilies.id, target.familyId))
      .for('update');

    // Re-read under the lock; the row may have changed while we waited.
    const [current] = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.orgId, input.orgId)))
      .limit(1);

    if (!current) {
      throw new KeyStoreError('not_found', 'API key not found');
    }
    if (current.status === 'revoked') {
      throw new KeyStoreError('already_revoked', 'API key is already revoked');
    }
    // Rotating a key that was already superseded is allowed on purpose:
    // the new key becomes the family's current key and every other
    // current key is retired below. The lock above is what keeps that to
    // exactly one current key when rotations run concurrently.
    //
    // The successor inherits the expiry, so an expired key would produce
    // a key that is dead on arrival.
    if (current.expiresAt && current.expiresAt <= new Date()) {
      throw new KeyStoreError('invalid_expiry', 'An expired key cannot be rotated');
    }

    const oldScopes = normalizeScopes(current.scopes);
    const nextScopes = input.scopes ? normalizeScopes(input.scopes) : oldScopes;

    if (!isSuperset(nextScopes, oldScopes)) {
      throw new KeyStoreError(
        'invalid_scopes',
        `Rotated key must keep every scope of the current key (${oldScopes.join(', ')})`,
      );
    }

    const keyMaterial = generateKeyMaterial(current.env);
    const hash = hashSecret(keyMaterial.publicId, keyMaterial.secret);

    const [row] = await tx
      .insert(apiKeys)
      .values({
        orgId: current.orgId,
        familyId: current.familyId,
        name: current.name,
        publicId: keyMaterial.publicId,
        prefix: keyMaterial.prefix,
        secretHash: hash,
        last4: keyMaterial.last4,
        env: current.env,
        scopes: nextScopes,
        status: 'active',
        expiresAt: current.expiresAt,
        rotatedFrom: current.id,
        createdBy: current.createdBy,
      })
      .returning({
        id: apiKeys.id,
        familyId: apiKeys.familyId,
        expiresAt: apiKeys.expiresAt,
      });

    if (!row) throw new Error('Failed to create rotated api key');

    // Retire every *current* key in the family except the one we just
    // minted. A key is "current" when it has no grace window, and a family
    // must have at most one current key at a time.
    const retired = await tx
      .update(apiKeys)
      .set({ graceUntil })
      .where(
        and(
          eq(apiKeys.familyId, current.familyId),
          eq(apiKeys.status, 'active'),
          isNull(apiKeys.graceUntil),
          ne(apiKeys.id, row.id),
        ),
      )
      .returning({ publicId: apiKeys.publicId });

    return {
      result: row,
      existing: current,
      scopes: nextScopes,
      retiredPublicIds: retired.map((r) => r.publicId),
      key: keyMaterial,
    };
  });

  await recordEvent({
    keyId: result.id,
    familyId: result.familyId,
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    event: 'rotated',
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { previousKeyId: existing.id, graceUntil: graceUntil.toISOString(), scopes },
  });

  // Every key whose grace window just changed must be re-read from Postgres.
  await invalidateCachedKey(existing.publicId);
  await invalidatePublicIds(retiredPublicIds);
  await forgetMissingKey(key.publicId);

  return {
    id: result.id,
    familyId: result.familyId,
    key: key.key,
    prefix: key.prefix,
    last4: key.last4,
    env: existing.env,
    scopes,
    expiresAt: result.expiresAt,
  };
}

/** Invalidate cached rows, logging rather than failing an already-committed change. */
async function invalidatePublicIds(publicIds: string[]): Promise<void> {
  try {
    await invalidateKeys(publicIds);
  } catch (err) {
    console.error('[keys] cache invalidation failed; affected keys refresh within 60s:', err);
  }
}

/**
 * Revoke a single key. Immediate and authoritative: the row is the source of
 * truth, and the cached copy is tombstoned so a verification racing with the
 * revoke cannot write the old row back.
 */
export async function revokeKey(
  orgId: string,
  keyId: string,
  context: {
    actorUserId?: string | undefined;
    ip?: string | undefined;
    userAgent?: string | undefined;
  } = {},
): Promise<void> {
  const [row] = await db
    .update(apiKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId), eq(apiKeys.status, 'active')))
    .returning({ id: apiKeys.id, familyId: apiKeys.familyId, publicId: apiKeys.publicId });

  if (!row) {
    const [existing] = await db
      .select({ id: apiKeys.id, status: apiKeys.status })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
      .limit(1);

    if (!existing) throw new KeyStoreError('not_found', 'API key not found');
    throw new KeyStoreError('already_revoked', 'API key is already revoked');
  }

  await recordEvent({
    keyId: row.id,
    familyId: row.familyId,
    orgId,
    actorUserId: context.actorUserId,
    event: 'revoked',
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await invalidatePublicIds([row.publicId]);
}

/**
 * Revoke a whole family — the kill switch.
 *
 * Every key in the rotation chain dies at once, which is why families exist as
 * a table rather than a self-referencing column.
 */
export async function revokeFamily(
  orgId: string,
  familyId: string,
  context: {
    actorUserId?: string | undefined;
    ip?: string | undefined;
    userAgent?: string | undefined;
  } = {},
): Promise<number> {
  const revokedPublicIds = await db.transaction(async (tx) => {
    const [family] = await tx
      .update(apiKeyFamilies)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeyFamilies.id, familyId), eq(apiKeyFamilies.orgId, orgId)))
      .returning({ id: apiKeyFamilies.id });

    if (!family) {
      const [existing] = await tx
        .select({ id: apiKeyFamilies.id })
        .from(apiKeyFamilies)
        .where(and(eq(apiKeyFamilies.id, familyId), eq(apiKeyFamilies.orgId, orgId)))
        .limit(1);

      if (!existing) throw new KeyStoreError('not_found', 'API key family not found');
    }

    const updated = await tx
      .update(apiKeys)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(apiKeys.familyId, familyId), eq(apiKeys.status, 'active')))
      .returning({ publicId: apiKeys.publicId });

    return updated.map((key) => key.publicId);
  });
  const revoked = revokedPublicIds.length;

  await recordEvent({
    keyId: null,
    familyId,
    orgId,
    actorUserId: context.actorUserId,
    event: 'family_revoked',
    ip: context.ip,
    userAgent: context.userAgent,
    metadata: { keysRevoked: revoked },
  });

  // Tombstone each revoked key by id rather than relying on the family's
  // cache index, which only lists keys that happened to be cached.
  await invalidatePublicIds(revokedPublicIds);
  await invalidateFamilyKeyCache(familyId);

  return revoked;
}
