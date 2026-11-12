import { randomBytes } from 'node:crypto';
import type { RateLimitResult } from '@throttlebox/shared';
import { redis } from '../db/redis.js';
import { SLIDING_WINDOW_LUA } from './lua.js';

let scriptSha: string | null = null;

export async function loadScript(): Promise<string> {
  if (!scriptSha) {
    scriptSha = (await redis.script('LOAD', SLIDING_WINDOW_LUA)) as string;
  }
  return scriptSha;
}

/** Reset cached SHA (for tests). */
export function resetScriptSha(): void {
  scriptSha = null;
}

export interface CheckRateLimitOptions {
  keyId?: string;
  orgId?: string;
  limit: number;
  windowSeconds: number;
  simulatedNowMs?: number;
}

/**
 * Check and record a request in the sliding window.
 *
 * Runs atomically via a Redis Lua script.
 * If orgId is provided, rate limits are aggregated across the entire organization
 * (matching plan tier capacities). If only keyId is provided, limits per key.
 * If Redis is temporarily unreachable, logs a warning and fails open
 * to avoid taking down caller traffic during minor blips.
 */
export async function checkRateLimit(options: CheckRateLimitOptions): Promise<RateLimitResult> {
  const { keyId, orgId, limit, windowSeconds, simulatedNowMs } = options;
  const bucketKey = orgId ? `rate:org:${orgId}` : `rate:key:${keyId ?? 'unknown'}`;
  const windowMs = windowSeconds * 1000;
  const memberId = `${Date.now()}:${randomBytes(6).toString('hex')}`;
  const nowMsArg = simulatedNowMs && simulatedNowMs > 0 ? String(simulatedNowMs) : '0';

  try {
    const sha = await loadScript();
    let result: [number, number, number, number, number];

    try {
      result = (await redis.evalsha(
        sha,
        1,
        bucketKey,
        String(windowMs),
        String(limit),
        memberId,
        nowMsArg,
      )) as [number, number, number, number, number];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NOSCRIPT')) {
        scriptSha = null;
        const newSha = await loadScript();
        result = (await redis.evalsha(
          newSha,
          1,
          bucketKey,
          String(windowMs),
          String(limit),
          memberId,
          nowMsArg,
        )) as [number, number, number, number, number];
      } else {
        throw err;
      }
    }

    const [allowedNum, effectiveLimit, remaining, resetAt, retryAfterSec] = result;
    const allowed = allowedNum === 1;

    return {
      allowed,
      limit: effectiveLimit,
      remaining,
      resetAt,
      ...(allowed ? {} : { retryAfter: retryAfterSec }),
    };
  } catch (err) {
    console.error('[ratelimit] Redis error in checkRateLimit:', err);
    // Fail-open strategy: allow request on cache failure so mock endpoints stay available
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - 1),
      resetAt: Math.ceil((Date.now() + windowMs) / 1000),
    };
  }
}
