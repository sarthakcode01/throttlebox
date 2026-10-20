import { and, desc, eq } from 'drizzle-orm';
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
      throw new KeyStoreError('invalid_scopes', `expiresInDays must be 1–${MAX_EXPIRY_DAYS}`);
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

  const [existing] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.orgId, input.orgId)))
    .limit(1);

  if (!existing) {
    throw new KeyStoreError('not_found', 'API key not found');
  }
  if (existing.status === 'revoked') {
    throw new KeyStoreError('already_revoked', 'API key is already revoked');
  }

  const oldScopes = normalizeScopes(existing.scopes);
  const scopes = input.scopes ? normalizeScopes(input.scopes) : oldScopes;

  if (!isSuperset(scopes, oldScopes)) {
    throw new KeyStoreError(
      'invalid_scopes',
      `Rotated key must keep every scope of the current key (${oldScopes.join(', ')})`,
    );
  }

  const material = generateKeyMaterial(existing.env);
  const secretHash = hashSecret(material.publicId, material.secret);
  const graceUntil = new Date(Date.now() + graceHours * 60 * 60 * 1000);

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apiKeys)
      .values({
        orgId: existing.orgId,
        familyId: existing.familyId,
        name: existing.name,
        publicId: material.publicId,
        prefix: material.prefix,
        secretHash,
        last4: material.last4,
        env: existing.env,
        scopes,
        status: 'active',
        expiresAt: existing.expiresAt,
        rotatedFrom: existing.id,
        createdBy: existing.createdBy,
      })
      .returning({
        id: apiKeys.id,
        familyId: apiKeys.familyId,
        expiresAt: apiKeys.expiresAt,
      });

    if (!row) throw new Error('Failed to create rotated api key');

    // The old key keeps `status = 'active'`; the grace window is what retires
    // it. Verification checks `grace_until` explicitly.
    await tx.update(apiKeys).set({ graceUntil }).where(eq(apiKeys.id, existing.id));

    return row;
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

  return {
    id: result.id,
    familyId: result.familyId,
    key: material.key,
    prefix: material.prefix,
    last4: material.last4,
    env: existing.env,
    scopes,
    expiresAt: result.expiresAt,
  };
}

/**
 * Revoke a single key. Immediate and authoritative: the row is the source of
 * truth, so there is no cache to invalidate yet.
 *
 * (Phase 4 adds a Redis cache on the lookup path and must purge it here, or a
 * revoked key stays live for up to the cache TTL.)
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
    .returning({ id: apiKeys.id, familyId: apiKeys.familyId });

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
  const revoked = await db.transaction(async (tx) => {
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
      .returning({ id: apiKeys.id });

    return updated.length;
  });

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

  return revoked;
}
