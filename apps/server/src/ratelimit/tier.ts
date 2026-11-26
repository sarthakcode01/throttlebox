import { eq } from 'drizzle-orm';
import { PLAN_CONFIGS, type Plan, type PlanConfig } from '@throttlebox/shared';
import Redis from 'ioredis';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { redis } from '../db/redis.js';
import { orgs } from '../db/schema.js';

const TIER_CACHE_TTL_MS = 30_000;
const TIER_REDIS_TTL_SEC = 60;
const PLAN_CHANGED_CHANNEL = 'plan:changed';

interface LocalCacheEntry {
  config: PlanConfig;
  expiresAt: number;
}

/**
 * The in-process tier cache.
 *
 * Every entry expires after 30 s, but an expired entry is only removed when the
 * same org is looked up again. Orgs that go quiet therefore stay in the map
 * forever, and the process accumulates one entry per org it has ever seen.
 *
 * Bounded instead: keys are approximately recency-ordered (every read that hits
 * a live entry re-inserts it, and `Map` preserves insertion order), so the
 * oldest key is the first to go. A capacity that is larger than any realistic
 * working set keeps the hit rate intact.
 */
const TIER_CACHE_MAX_ENTRIES = 10_000;

const localTierCache = new Map<string, LocalCacheEntry>();

function cacheTier(orgId: string, entry: LocalCacheEntry): void {
  // Re-insert so this key moves to the end: the eviction order is what keeps
  // the bound from evicting the hot set.
  localTierCache.delete(orgId);
  localTierCache.set(orgId, entry);

  while (localTierCache.size > TIER_CACHE_MAX_ENTRIES) {
    const oldest = localTierCache.keys().next();
    if (oldest.done) break;
    localTierCache.delete(oldest.value);
  }
}

function tierRedisKey(orgId: string): string {
  return `tier:org:${orgId}`;
}

let subscriberRedis: Redis | null = null;

/**
 * Start listening for real-time plan changes published by any instance.
 */
export function startTierPubSub(): void {
  if (subscriberRedis) return;

  try {
    subscriberRedis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    subscriberRedis.subscribe(PLAN_CHANGED_CHANNEL, (err) => {
      if (err) {
        console.error('[ratelimit:pubsub] Failed to subscribe to plan changes:', err.message);
      }
    });

    subscriberRedis.on('message', (channel, message) => {
      if (channel === PLAN_CHANGED_CHANNEL) {
        try {
          const { orgId } = JSON.parse(message) as { orgId: string; plan: Plan };
          if (orgId) {
            invalidateLocalOrgPlan(orgId);
          }
        } catch (err) {
          console.error('[ratelimit:pubsub] Failed to parse message:', err);
        }
      }
    });

    subscriberRedis.on('error', (err) => {
      console.error('[ratelimit:pubsub] Subscriber Redis error:', err.message);
    });
  } catch (err) {
    console.error('[ratelimit:pubsub] Failed to initialize subscriber:', err);
  }
}

/**
 * Stop subscriber connection during graceful shutdown.
 */
export async function stopTierPubSub(): Promise<void> {
  if (subscriberRedis) {
    try {
      await subscriberRedis.unsubscribe(PLAN_CHANGED_CHANNEL);
      subscriberRedis.disconnect();
    } catch {
      // ignore on shutdown
    } finally {
      subscriberRedis = null;
    }
  }
}

/**
 * Invalidate in-memory plan cache for an org.
 */
export function invalidateLocalOrgPlan(orgId: string): void {
  localTierCache.delete(orgId);
}

/**
 * Invalidate both local memory and Redis cache for an org.
 */
export async function invalidateOrgPlan(orgId: string): Promise<void> {
  invalidateLocalOrgPlan(orgId);
  try {
    await redis.del(tierRedisKey(orgId));
  } catch (err) {
    console.error('[ratelimit:tier] Failed to invalidate Redis tier cache:', err);
  }
}

/**
 * Resolve the rate limit configuration for an organization.
 *
 * Check order:
 *  1. In-process memory cache (30s)
 *  2. Redis cache (60s)
 *  3. Postgres `orgs` table -> fallback to 'free'
 */
export async function getOrgPlan(orgId: string): Promise<PlanConfig> {
  const now = Date.now();

  // 1. In-memory check
  const local = localTierCache.get(orgId);
  if (local && local.expiresAt > now) {
    cacheTier(orgId, local);
    return local.config;
  }
  // Drop the stale entry rather than leaving it to be overwritten later.
  localTierCache.delete(orgId);

  // 2. Redis cache check
  try {
    const cachedPlan = await redis.get(tierRedisKey(orgId));
    if (cachedPlan && cachedPlan in PLAN_CONFIGS) {
      const planConfig = PLAN_CONFIGS[cachedPlan as Plan];
      cacheTier(orgId, {
        config: planConfig,
        expiresAt: now + TIER_CACHE_TTL_MS,
      });
      return planConfig;
    }
  } catch (err) {
    console.error('[ratelimit:tier] Redis lookup error:', err);
  }

  // 3. Database lookup
  let planName: Plan = 'free';
  try {
    const [row] = await db
      .select({ plan: orgs.plan })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);

    if (row?.plan && row.plan in PLAN_CONFIGS) {
      planName = row.plan as Plan;
    }
  } catch (err) {
    console.error('[ratelimit:tier] Database lookup error:', err);
  }

  const planConfig = PLAN_CONFIGS[planName] ?? PLAN_CONFIGS.free;

  // Populate local and Redis cache
  cacheTier(orgId, {
    config: planConfig,
    expiresAt: now + TIER_CACHE_TTL_MS,
  });

  try {
    await redis.setex(tierRedisKey(orgId), TIER_REDIS_TTL_SEC, planName);
  } catch (err) {
    console.error('[ratelimit:tier] Failed to write Redis cache:', err);
  }

  return planConfig;
}

/**
 * Update an organization's plan and broadcast the change across all instances.
 */
export async function updateOrgPlan(orgId: string, newPlan: Plan): Promise<PlanConfig> {
  const planConfig = PLAN_CONFIGS[newPlan];
  if (!planConfig) {
    throw new Error(`Unknown plan: ${newPlan}`);
  }

  // 1. Update database
  await db.update(orgs).set({ plan: newPlan }).where(eq(orgs.id, orgId));

  // 2. Invalidate local and Redis cache
  await invalidateOrgPlan(orgId);

  // 3. Publish to Redis pub/sub channel for other instances
  try {
    await redis.publish(PLAN_CHANGED_CHANNEL, JSON.stringify({ orgId, plan: newPlan }));
  } catch (err) {
    console.error('[ratelimit:tier] Failed to publish plan:changed:', err);
  }

  return planConfig;
}
