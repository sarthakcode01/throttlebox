import type { KeyEnv, KeyStatus } from '@throttlebox/shared';
import Redis from 'ioredis';
import { config } from '../config.js';
import { redis } from '../db/redis.js';

/**
 * Everything about a key that is safe to cache.
 *
 * Note what is **not** here: `secretHash`. The cached row used to carry the
 * HMAC digest of the key's secret, which widened the blast radius of a Redis
 * compromise from "rate counters and a plan name" to "verifiable credential
 * digests". It does not yield a usable key (HMAC is one-way and peppered), but
 * there was no reason to expose it: only a cache *miss* has the database row,
 * and the secret is compared against that.
 */
export interface CachedKeyRow {
  id: string;
  orgId: string;
  familyId: string;
  env: KeyEnv;
  scopes: string[];
  status: KeyStatus;
  /** Whether the key has an expiry at all, plus its value. */
  expiresAt: string | null;
  graceUntil: string | null;
  familyRevokedAt: string | null;
}

const KEY_CACHE_TTL_SECONDS = 60;
const KEY_INVALIDATED_CHANNEL = 'key:invalidated';

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
 * Retrieve a cached key record.
 *
 * Returns null on a miss *or* on any error: a cache that cannot be read must
 * not be treated as authoritative, and the caller falls back to Postgres.
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
 *
 * The delete is local; `broadcast` tells every other replica to drop its copy.
 * Before this, a revocation only cleared the cache of the instance that handled
 * the request, so a revoked key stayed live for up to 60s everywhere else.
 */
export async function invalidateCachedKey(publicId: string, broadcast = true): Promise<void> {
  try {
    await redis.del(keyCacheKey(publicId));
  } catch (err) {
    console.error('[keyCache] Error invalidating key cache:', err);
  }

  if (broadcast) await broadcastInvalidation({ publicIds: [publicId] });
}

export async function invalidateCachedKeyById(keyId: string, broadcast = true): Promise<void> {
  try {
    const publicId = await redis.get(idToPublicKey(keyId));
    const pipeline = redis.pipeline();
    pipeline.del(idToPublicKey(keyId));
    if (publicId) {
      pipeline.del(keyCacheKey(publicId));
    }
    await pipeline.exec();

    if (publicId && broadcast) await broadcastInvalidation({ publicIds: [publicId] });
  } catch (err) {
    console.error('[keyCache] Error invalidating key by id:', err);
  }
}

export async function invalidateFamilyKeyCache(familyId: string, broadcast = true): Promise<void> {
  try {
    const publicIds = await redis.smembers(familyKeysKey(familyId));
    const pipeline = redis.pipeline();
    for (const publicId of publicIds) {
      pipeline.del(keyCacheKey(publicId));
    }
    pipeline.del(familyKeysKey(familyId));
    await pipeline.exec();

    if (publicIds.length > 0 && broadcast) await broadcastInvalidation({ publicIds });
  } catch (err) {
    console.error('[keyCache] Error invalidating family key cache:', err);
  }
}

interface InvalidationMessage {
  publicIds: string[];
}

async function broadcastInvalidation(message: InvalidationMessage): Promise<void> {
  try {
    await redis.publish(KEY_INVALIDATED_CHANNEL, JSON.stringify(message));
  } catch (err) {
    // Not fatal: the local delete already happened, and the remaining exposure
    // is bounded by the cache TTL.
    console.error('[keyCache] Failed to broadcast invalidation:', err);
  }
}

let subscriberRedis: Redis | null = null;

/** Start listening for key invalidations published by any instance. */
export function startKeyCachePubSub(): void {
  if (subscriberRedis) return;

  try {
    subscriberRedis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    subscriberRedis.subscribe(KEY_INVALIDATED_CHANNEL, (err) => {
      if (err) {
        console.error('[keyCache:pubsub] Failed to subscribe to invalidations:', err.message);
      }
    });

    subscriberRedis.on('message', (channel, raw) => {
      if (channel !== KEY_INVALIDATED_CHANNEL) return;
      try {
        const { publicIds } = JSON.parse(raw) as InvalidationMessage;
        if (!Array.isArray(publicIds) || publicIds.length === 0) return;
        const pipeline = redis.pipeline();
        for (const publicId of publicIds) {
          pipeline.del(keyCacheKey(publicId));
        }
        void pipeline.exec().catch((err) => {
          console.error('[keyCache:pubsub] Failed to drop invalidated keys:', err);
        });
      } catch (err) {
        console.error('[keyCache:pubsub] Failed to parse invalidation:', err);
      }
    });

    subscriberRedis.on('error', (err) => {
      console.error('[keyCache:pubsub] Subscriber Redis error:', err.message);
    });
  } catch (err) {
    console.error('[keyCache:pubsub] Failed to initialize subscriber:', err);
  }
}

/** Stop the subscriber connection during graceful shutdown. */
export async function stopKeyCachePubSub(): Promise<void> {
  if (subscriberRedis) {
    try {
      await subscriberRedis.unsubscribe(KEY_INVALIDATED_CHANNEL);
      subscriberRedis.disconnect();
    } catch {
      // ignore on shutdown
    } finally {
      subscriberRedis = null;
    }
  }
}
