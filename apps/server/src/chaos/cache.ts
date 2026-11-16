import { and, eq, isNull } from 'drizzle-orm';
import Redis from 'ioredis';
import type {
  ChaosErrorConfig,
  ChaosLatencyConfig,
  ChaosPartitionConfig,
  ChaosRuleConfig,
} from '@throttlebox/shared';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { redis } from '../db/redis.js';
import { chaosRules, type ChaosRule } from '../db/schema.js';

const LOCAL_CACHE_TTL_MS = 5000;
const REDIS_CACHE_TTL_SEC = 60;
const CHAOS_INVALIDATE_CHANNEL = 'chaos:invalidated';
const MAX_LOCAL_ENTRIES = 1000;

interface LocalEntry {
  rule: ChaosRuleConfig | null;
  expiresAt: number;
}

const localCache = new Map<string, LocalEntry>();

/** Bumped on every invalidation; see `getCachedChaosRule`. */
let cacheGeneration = 0;
let subscriberRedis: Redis | null = null;

function makeKey(orgId: string, serviceId?: string | null, keyId?: string | null): string {
  return `chaos:rule:${orgId}:${serviceId ?? '_'}:${keyId ?? '_'}`;
}

function setLocalCache(key: string, entry: LocalEntry): void {
  if (localCache.size >= MAX_LOCAL_ENTRIES) {
    const now = Date.now();
    // Prune expired entries first
    for (const [k, v] of localCache.entries()) {
      if (v.expiresAt <= now) {
        localCache.delete(k);
      }
    }
    // If still at capacity, evict the oldest key (FIFO from Map iterator)
    if (localCache.size >= MAX_LOCAL_ENTRIES) {
      const oldestKey = localCache.keys().next().value;
      if (oldestKey) {
        localCache.delete(oldestKey);
      }
    }
  }
  localCache.set(key, entry);
}

export function toChaosRuleConfig(row: ChaosRule): ChaosRuleConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    serviceId: row.serviceId,
    keyId: row.keyId,
    isEnabled: row.isEnabled,
    latency: row.latency as ChaosLatencyConfig,
    errors: row.errors as ChaosErrorConfig,
    partition: row.partition as ChaosPartitionConfig,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolves the applicable chaos rule for an incoming request.
 *
 * Checks in order of specificity:
 * 1. (orgId, serviceId, keyId)
 * 2. (orgId, serviceId, null)
 * 3. (orgId, null, keyId)
 * 4. (orgId, null, null) - Org-wide default
 *
 * The most specific rule defined in the database hierarchy governs the request.
 * A specific rule with `isEnabled: false` cleanly overrides an org-wide default,
 * allowing developers to exempt critical services or keys from org-wide chaos testing.
 */
export async function resolveChaosRule(
  orgId: string,
  serviceId?: string | null,
  keyId?: string | null,
): Promise<ChaosRuleConfig | null> {
  // Check exact scope first, then fallback to org default
  const scopesToTry: [string | null | undefined, string | null | undefined][] = [];
  if (serviceId && keyId) scopesToTry.push([serviceId, keyId]);
  if (serviceId) scopesToTry.push([serviceId, null]);
  if (keyId) scopesToTry.push([null, keyId]);
  scopesToTry.push([null, null]);

  for (const [sId, kId] of scopesToTry) {
    const rule = await chaosCache.getCachedChaosRule(orgId, sId, kId);
    if (rule !== null) {
      return rule;
    }
  }

  return null;
}

/**
 * Retrieves a single scoped chaos rule using two-tier caching (Memory -> Redis -> DB).
 */
export async function getCachedChaosRule(
  orgId: string,
  serviceId?: string | null,
  keyId?: string | null,
): Promise<ChaosRuleConfig | null> {
  const cacheKey = makeKey(orgId, serviceId, keyId);
  const now = Date.now();
  // A lookup that started before an invalidation must not write what it
  // read back into the caches afterwards, or the old rule would come back
  // for the length of the TTL.
  const generation = cacheGeneration;

  // 1. Check in-memory L1 cache
  const local = localCache.get(cacheKey);
  if (local && local.expiresAt > now) {
    return local.rule;
  }

  // 2. Check Redis L2 cache
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      const parsed = cached === '' ? null : (JSON.parse(cached) as ChaosRuleConfig);
      if (generation === cacheGeneration) {
        setLocalCache(cacheKey, { rule: parsed, expiresAt: now + LOCAL_CACHE_TTL_MS });
      }
      return parsed;
    }
  } catch (err) {
    console.warn('[chaos:cache] Redis lookup error:', err);
  }

  // 3. Fallback to PostgreSQL
  const conditions = [eq(chaosRules.orgId, orgId)];
  if (serviceId) {
    conditions.push(eq(chaosRules.serviceId, serviceId));
  } else {
    conditions.push(isNull(chaosRules.serviceId));
  }

  if (keyId) {
    conditions.push(eq(chaosRules.keyId, keyId));
  } else {
    conditions.push(isNull(chaosRules.keyId));
  }

  const [row] = await db
    .select()
    .from(chaosRules)
    .where(and(...conditions))
    .limit(1);

  const ruleConfig = row ? toChaosRuleConfig(row) : null;

  if (generation !== cacheGeneration) return ruleConfig;

  // Populate L2 (Redis) and L1 (Memory)
  try {
    const val = ruleConfig ? JSON.stringify(ruleConfig) : '';
    await redis.set(cacheKey, val, 'EX', REDIS_CACHE_TTL_SEC);
  } catch (err) {
    console.warn('[chaos:cache] Redis set error:', err);
  }

  setLocalCache(cacheKey, { rule: ruleConfig, expiresAt: now + LOCAL_CACHE_TTL_MS });
  return ruleConfig;
}

/**
 * Delete every cached rule for an org.
 *
 * `SCAN`, not `KEYS`: `KEYS` walks the whole keyspace in one blocking call,
 * which stalls every other Redis client on the instance.
 */
async function deleteOrgKeys(orgId: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `chaos:rule:${orgId}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

/**
 * Invalidates chaos rule cache locally and broadcasts across Redis Pub/Sub.
 */
export async function invalidateChaosRule(
  orgId: string,
  serviceId?: string | null,
  keyId?: string | null,
  broadcast = true,
): Promise<void> {
  const cacheKey = makeKey(orgId, serviceId, keyId);
  cacheGeneration += 1;
  localCache.delete(cacheKey);

  // Clear all local cache entries for this org to handle wildcards cleanly
  for (const k of localCache.keys()) {
    if (k.startsWith(`chaos:rule:${orgId}:`)) {
      localCache.delete(k);
    }
  }

  try {
    if (!serviceId && !keyId) {
      // When resetting or modifying org defaults, invalidate all Redis keys for this org
      await deleteOrgKeys(orgId);
    } else {
      await redis.del(cacheKey);
    }
  } catch (err) {
    console.warn('[chaos:cache] Redis invalidation error:', err);
  }

  if (broadcast) {
    try {
      await redis.publish(
        CHAOS_INVALIDATE_CHANNEL,
        JSON.stringify({ orgId, serviceId: serviceId ?? null, keyId: keyId ?? null }),
      );
    } catch (err) {
      console.warn('[chaos:cache] Failed to broadcast invalidation:', err);
    }
  }
}

/**
 * Starts listening to distributed chaos rule updates over Redis Pub/Sub.
 */
export function startChaosPubSub(): void {
  if (subscriberRedis) return;

  try {
    subscriberRedis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    subscriberRedis.subscribe(CHAOS_INVALIDATE_CHANNEL, (err) => {
      if (err) {
        console.error('[chaos:pubsub] Failed to subscribe to chaos invalidations:', err.message);
      }
    });

    subscriberRedis.on('message', (channel, message) => {
      if (channel === CHAOS_INVALIDATE_CHANNEL) {
        try {
          const { orgId, serviceId, keyId } = JSON.parse(message) as {
            orgId: string;
            serviceId?: string | null;
            keyId?: string | null;
          };
          if (orgId) {
            void invalidateChaosRule(orgId, serviceId, keyId, false);
          }
        } catch (err) {
          console.error('[chaos:pubsub] Failed to parse invalidation message:', err);
        }
      }
    });

    subscriberRedis.on('error', (err) => {
      console.error('[chaos:pubsub] Subscriber Redis error:', err.message);
    });
  } catch (err) {
    console.error('[chaos:pubsub] Failed to initialize chaos subscriber:', err);
  }
}

/**
 * Shuts down the Redis Pub/Sub subscriber during server termination.
 */
export async function stopChaosPubSub(): Promise<void> {
  if (subscriberRedis) {
    try {
      await subscriberRedis.unsubscribe(CHAOS_INVALIDATE_CHANNEL);
      subscriberRedis.disconnect();
    } catch {
      // ignore
    } finally {
      subscriberRedis = null;
    }
  }
}

export const chaosCache = {
  getCachedChaosRule,
  resolveChaosRule,
};
