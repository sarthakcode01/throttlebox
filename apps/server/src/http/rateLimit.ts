import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { redis } from '../db/redis.js';
import { SLIDING_WINDOW_LUA } from '../ratelimit/lua.js';

export interface RateLimitOptions {
  /** How many requests are allowed inside the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Identifies the bucket a request counts against. */
  keyGenerator: (request: FastifyRequest) => string;
  /** Set false to make the limiter a no-op. */
  enabled?: boolean;
  message?: string;
  /**
   * Namespace for the Redis bucket. Kept separate from the mock API's
   * `rate:org:<id>` buckets so a credential limit and a plan limit can never
   * share a counter.
   */
  prefix?: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  /** Fastify `preHandler` hook. */
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Forget every bucket. Used by tests. */
  reset: () => void;
  /** Number of live buckets. Used by tests. */
  size: () => number;
}

let scriptSha: string | null = null;

async function loadScript(): Promise<string> {
  scriptSha ??= (await redis.script('LOAD', SLIDING_WINDOW_LUA)) as string;
  return scriptSha;
}

/**
 * Count one hit in a shared sliding window.
 *
 * Reuses the Lua primitive from the mock rate limiter so the semantics are
 * identical (atomic trim → count → insert, Redis-side clock), and returns the
 * same shape the caller needs for headers.
 */
async function checkShared(
  bucket: string,
  max: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number; retryAfter: number } | null> {
  // A client that is not connected would spend its retry budget rejecting
  // every call, so short-circuit to the in-process bucket instead. This also
  // keeps the limiter's behaviour deterministic in environments without Redis.
  if (redis.status !== 'ready') return null;

  const memberId = `${Date.now()}:${randomBytes(6).toString('hex')}`;

  try {
    const sha = await loadScript();
    const call = () =>
      redis.evalsha(sha, 1, bucket, String(windowMs), String(max), memberId, '0') as Promise<
        [number, number, number, number, number]
      >;

    let result: [number, number, number, number, number];
    try {
      result = await call();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('NOSCRIPT')) throw err;
      scriptSha = null;
      await loadScript();
      result = await call();
    }

    const [allowedNum, , remaining, resetAt, retryAfter] = result;
    return {
      allowed: allowedNum === 1,
      remaining,
      resetAt,
      retryAfter: retryAfter ?? 1,
    };
  } catch (err) {
    // Unlike the mock limiter, a credential limiter does not fail open: the
    // thing it is protecting (an Argon2id verification, or a password change)
    // is exactly what an attacker wants to run in a loop during an outage.
    // Returning null tells the caller to use its in-process bucket instead.
    console.error('[ratelimit] Shared credential limit unavailable:', err);
    return null;
  }
}

/**
 * A fixed-window rate limiter for credential endpoints.
 *
 * Two layers:
 *
 *  1. **In-process**, checked first. Zero latency, and it is what the tests
 *     exercise without a database.
 *  2. **Redis**, shared across instances. The in-process limiter alone gives a
 *     multi-instance deployment `N × max` attempts, which materially weakens
 *     the defence in front of Argon2id. The Redis layer makes the ceiling the
 *     configured one no matter how many replicas are running.
 *
 * If Redis is unreachable the in-process bucket still applies, so the endpoint
 * degrades to the old behaviour rather than becoming unlimited.
 */
export function createRateLimit(options: RateLimitOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const { max, windowMs, keyGenerator, message, prefix = 'ratelimit:auth' } = options;

  async function handler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (options.enabled === false) return;

    const now = Date.now();
    const key = keyGenerator(request);

    // Opportunistically drop expired buckets so the map cannot grow without
    // bound. Cheap enough to do inline at this scale.
    if (buckets.size > 10_000) {
      for (const [existingKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(existingKey);
      }
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    let remaining = Math.max(0, max - bucket.count);
    let resetAt = Math.ceil(bucket.resetAt / 1000);
    let retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    let blocked = bucket.count > max;

    // The shared window is the authoritative one across instances.
    const shared = await checkShared(`${prefix}:${key}`, max, windowMs);
    if (shared) {
      remaining = Math.min(remaining, Math.max(0, shared.remaining));
      resetAt = shared.allowed ? Math.min(resetAt, shared.resetAt) : shared.resetAt;
      retryAfter = shared.allowed ? retryAfter : Math.max(1, shared.retryAfter);
      blocked = blocked || !shared.allowed;
    }

    reply.header('X-RateLimit-Limit', String(max));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String(resetAt));

    if (blocked) {
      reply.header('Retry-After', String(retryAfter));
      await reply
        .code(429)
        .send({ error: 'rate_limited', message: message ?? 'Too many requests' });
    }
  }

  return {
    handler,
    reset: () => buckets.clear(),
    size: () => buckets.size,
  };
}
