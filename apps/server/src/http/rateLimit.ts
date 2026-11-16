import type { FastifyReply, FastifyRequest } from 'fastify';
import { checkRateLimit } from '../ratelimit/limiter.js';

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
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  /** Fastify `preHandler` hook. */
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Forget every local fallback bucket. Used by tests. */
  reset: () => void;
  /** Number of live local fallback buckets. Used by tests. */
  size: () => number;
}

/**
 * A sliding-window rate limiter for the dashboard and credential endpoints.
 *
 * The count lives in Redis, using the same atomic Lua script as the mock
 * API limiter, so every instance shares one budget. A per-process limiter
 * gave an N-instance deployment N times the limit, which is exactly what
 * credential stuffing wants.
 *
 * If Redis is unreachable the limiter does not fail open. It falls back to
 * a fixed window held in process memory, which is weaker across instances
 * but still a ceiling on Argon2id work during an outage.
 */
export function createRateLimit(options: RateLimitOptions): RateLimiter {
  const fallbackBuckets = new Map<string, Bucket>();
  const { max, windowMs, keyGenerator, message } = options;
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  function checkLocally(key: string, now: number) {
    if (fallbackBuckets.size > 10_000) {
      for (const [existingKey, bucket] of fallbackBuckets) {
        if (bucket.resetAt <= now) fallbackBuckets.delete(existingKey);
      }
    }

    let bucket = fallbackBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      fallbackBuckets.set(key, bucket);
    }
    bucket.count += 1;

    return {
      allowed: bucket.count <= max,
      remaining: Math.max(0, max - bucket.count),
      resetAt: Math.ceil(bucket.resetAt / 1000),
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  async function handler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (options.enabled === false) return;

    const key = keyGenerator(request);
    let decision = await checkRateLimit({
      bucketKey: `ratelimit:${key}`,
      limit: max,
      windowSeconds,
    });

    if (decision.degraded) {
      decision = { ...decision, ...checkLocally(key, Date.now()) };
    }

    reply.header('X-RateLimit-Limit', String(max));
    reply.header('X-RateLimit-Remaining', String(decision.remaining));
    reply.header('X-RateLimit-Reset', String(decision.resetAt));

    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfter ?? 1));
      await reply
        .code(429)
        .send({ error: 'rate_limited', message: message ?? 'Too many requests' });
    }
  }

  return {
    handler,
    reset: () => fallbackBuckets.clear(),
    size: () => fallbackBuckets.size,
  };
}
