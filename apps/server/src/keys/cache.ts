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

const KEY_CACHE_TTL_SECONDS = 60;

function keyCacheKey(publicId: string): string {
  return `cache:key:${publicId}`;
}

function idToPublicKey(keyId: string): string {
  return `cache:key:id:${keyId}`;
}

function familyKeysKey(familyId: string): string {
  return `cache:family:${familyId}:keys`;
}

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
 * Cache key verification row in Redis.
 */
export async function setCachedKey(
  publicId: string,
  row: CachedKeyRow,
  ttlSeconds = KEY_CACHE_TTL_SECONDS,
): Promise<void> {
  try {
    const pipeline = redis.pipeline();
    pipeline.setex(keyCacheKey(publicId), ttlSeconds, JSON.stringify(row));
    pipeline.setex(idToPublicKey(row.id), ttlSeconds, publicId);
    pipeline.sadd(familyKeysKey(row.familyId), publicId);
    pipeline.expire(familyKeysKey(row.familyId), ttlSeconds * 2);
    await pipeline.exec();
  } catch (err) {
    console.error('[keyCache] Error writing to cache:', err);
  }
}

/**
 * Invalidate a cached key by its publicId.
 */
export async function invalidateCachedKey(publicId: string): Promise<void> {
  try {
    await redis.del(keyCacheKey(publicId));
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
    const pipeline = redis.pipeline();
    pipeline.del(idToPublicKey(keyId));
    if (publicId) {
      pipeline.del(keyCacheKey(publicId));
    }
    await pipeline.exec();
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
    const pipeline = redis.pipeline();
    for (const publicId of publicIds) {
      pipeline.del(keyCacheKey(publicId));
    }
    pipeline.del(familyKeysKey(familyId));
    await pipeline.exec();
  } catch (err) {
    console.error('[keyCache] Error invalidating family key cache:', err);
  }
}
