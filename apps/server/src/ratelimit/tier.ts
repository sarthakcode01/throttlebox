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

const localTierCache = new Map<string, LocalCacheEntry>();

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
    return local.config;
  }

  // 2. Redis cache check
  try {
    const cachedPlan = await redis.get(tierRedisKey(orgId));
    if (cachedPlan && cachedPlan in PLAN_CONFIGS) {
      const planConfig = PLAN_CONFIGS[cachedPlan as Plan];
      localTierCache.set(orgId, {
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
  localTierCache.set(orgId, {
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
