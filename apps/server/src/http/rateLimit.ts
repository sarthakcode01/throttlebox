import type { FastifyReply, FastifyRequest } from 'fastify';

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
  /** Forget every bucket. Used by tests. */
  reset: () => void;
  /** Number of live buckets. Used by tests. */
  size: () => number;
}

/**
 * A fixed-window rate limiter, held in process memory.
 *
 * This exists to protect the authentication endpoints from credential
 * stuffing and registration spam. It is deliberately simple and local — the
 * real per-key sliding-window limiter for the mock API is Phase 4, and that
 * one is Redis-backed so it works across instances.
 *
 * The trade-off is explicit: this limiter is per-process, so a multi-instance
 * deployment gets N times the limit. That is acceptable for a credential
 * stuffing defence (an attacker still cannot spread attempts across
 * instances efficiently) but it is not a substitute for the Phase 4 limiter.
 */
export function createRateLimit(options: RateLimitOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const { max, windowMs, keyGenerator, message } = options;

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

    const remaining = Math.max(0, max - bucket.count);
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    reply.header('X-RateLimit-Limit', String(max));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
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
