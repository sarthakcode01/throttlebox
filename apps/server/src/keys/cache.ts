import type { KeyEnv, KeyStatus } from '@throttlebox/shared';
import { redis } from '../db/redis.js';

export interface CachedKeyRow {
  id: string;
  orgId: string;
  familyId: string;
  env: KeyEnv;
  scopes: string[];
  status: KeyStatus;
  secretHash: string;
  expiresAt: string | null;
  graceUntil: string | null;
  familyRevokedAt: string | null;
}

/**
 * The key cache.
 *
 * There is no in-process layer: every instance reads the same Redis copy, so
 * a `DEL` takes effect everywhere at once and no pub/sub channel is needed.
 *
 * The gap that a plain `DEL` leaves is a race. A verification reads the row
 * from Postgres just before a revoke commits, the revoke deletes the cache
 * entry, and then the verification writes its stale "active" row back — and
 * the revoked key works for the rest of the TTL. A revoke therefore leaves a
 * short-lived tombstone, and the cache write is a Lua script that refuses to
 * write over one. Writes and tombstones are atomic in Redis, so whichever
 * comes second wins correctly.
 *
 * The cached row includes `secretHash`. That is a deliberate trade-off: a
 * Redis leak exposes hashes, which are still useless without `KEY_PEPPER`.
 */

const KEY_CACHE_TTL_SECONDS = 60;
/** Longer than any verification could take, so the race window is covered. */
const TOMBSTONE_TTL_SECONDS = 120;
/** How long an unknown public id is remembered as unknown. */
const MISS_TTL_SECONDS = 30;

function keyCacheKey(publicId: string): string {
  return `cache:key:${publicId}`;
}

function tombstoneKey(publicId: string): string {
  return `cache:key:tomb:${publicId}`;
}

function missKey(publicId: string): string {
  return `cache:key:miss:${publicId}`;
}

function idToPublicKey(keyId: string): string {
  return `cache:key:id:${keyId}`;
}

function familyKeysKey(familyId: string): string {
  return `cache:family:${familyId}:keys`;
}

/** KEYS[1] = cache key, KEYS[2] = tombstone. ARGV[1] = value, ARGV[2] = TTL. */
const SET_UNLESS_TOMBSTONED = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

/**
 * Retrieve cached key verification row from Redis.
 */
export async function getCachedKey(publicId: string): Promise<CachedKeyRow | null> {
  try {
    const raw = await redis.get(keyCacheKey(publicId));
    if (!raw) return null;
    return JSON.parse(raw) as CachedKeyRow;
  } catch (err) {
    console.error('[keyCache] Error reading from cache:', err);
    return null;
  }
}

/**
 * Cache key verification row in Redis, unless the key was just invalidated.
 */
export async function setCachedKey(
  publicId: string,
  row: CachedKeyRow,
  ttlSeconds = KEY_CACHE_TTL_SECONDS,
): Promise<void> {
  try {
    const written = await redis.eval(
      SET_UNLESS_TOMBSTONED,
      2,
      keyCacheKey(publicId),
      tombstoneKey(publicId),
      JSON.stringify(row),
      String(ttlSeconds),
    );
    if (written !== 1) return;

    const pipeline = redis.pipeline();
    pipeline.setex(idToPublicKey(row.id), ttlSeconds, publicId);
    pipeline.sadd(familyKeysKey(row.familyId), publicId);
    pipeline.expire(familyKeysKey(row.familyId), ttlSeconds * 2);
    await pipeline.exec();
  } catch (err) {
    console.error('[keyCache] Error writing to cache:', err);
  }
}

/**
 * Has this public id recently been looked up and found not to exist?
 *
 * Without this, every well-formed but unknown key cost a Postgres query, and
 * the rate limiter only runs after authentication.
 */
export async function isKnownMissingKey(publicId: string): Promise<boolean> {
  try {
    return (await redis.exists(missKey(publicId))) === 1;
  } catch {
    return false;
  }
}

export async function rememberMissingKey(publicId: string): Promise<void> {
  try {
    await redis.set(missKey(publicId), '1', 'EX', MISS_TTL_SECONDS);
  } catch {
    // A cache hint only.
  }
}

/** A freshly created key must not be shadowed by an old "unknown" entry. */
export async function forgetMissingKey(publicId: string): Promise<void> {
  try {
    await redis.del(missKey(publicId));
  } catch {
    // A cache hint only.
  }
}

/**
 * Invalidate keys by public id: tombstone them, then drop the cached rows.
 *
 * Throws on a Redis failure, unlike the read paths. An invalidation that
 * silently did nothing is how a revoked key stays live.
 */
export async function invalidateKeys(publicIds: readonly string[]): Promise<void> {
  if (publicIds.length === 0) return;
  const pipeline = redis.pipeline();
  for (const publicId of publicIds) {
    pipeline.set(tombstoneKey(publicId), '1', 'EX', TOMBSTONE_TTL_SECONDS);
    pipeline.del(keyCacheKey(publicId));
  }
  const results = await pipeline.exec();
  const failure = results?.find(([err]) => err);
  if (failure?.[0]) throw failure[0];
}

/**
 * Invalidate a cached key by its publicId.
 */
export async function invalidateCachedKey(publicId: string): Promise<void> {
  try {
    await invalidateKeys([publicId]);
  } catch (err) {
    console.error('[keyCache] Error invalidating key cache:', err);
  }
}

/**
 * Invalidate a cached key by its database keyId.
 */
export async function invalidateCachedKeyById(keyId: string): Promise<void> {
  try {
    const publicId = await redis.get(idToPublicKey(keyId));
    await redis.del(idToPublicKey(keyId));
    if (publicId) await invalidateKeys([publicId]);
  } catch (err) {
    console.error('[keyCache] Error invalidating key by id:', err);
  }
}

/**
 * Invalidate all cached keys belonging to a family.
 */
export async function invalidateFamilyKeyCache(familyId: string): Promise<void> {
  try {
    const publicIds = await redis.smembers(familyKeysKey(familyId));
    await invalidateKeys(publicIds);
    await redis.del(familyKeysKey(familyId));
  } catch (err) {
    console.error('[keyCache] Error invalidating family key cache:', err);
  }
}
