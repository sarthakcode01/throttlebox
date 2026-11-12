import { describe, expect, it, vi } from 'vitest';
import { PLAN_CONFIGS } from '@throttlebox/shared';
import { checkRateLimit, resetScriptSha } from '../../src/ratelimit/limiter.js';
import { redis } from '../../src/db/redis.js';

describe('tier configuration and limits', () => {
  it('defines correct free tier specifications', () => {
    const free = PLAN_CONFIGS.free;
    expect(free.id).toBe('free');
    expect(free.requestsPerWindow).toBe(100);
    expect(free.windowSeconds).toBe(3600);
    expect(free.burstAllowance).toBe(1.0);

    const effectiveFree = Math.floor(free.requestsPerWindow * free.burstAllowance);
    expect(effectiveFree).toBe(100);
  });

  it('defines correct pro tier specifications with 20% burst allowance', () => {
    const pro = PLAN_CONFIGS.pro;
    expect(pro.id).toBe('pro');
    expect(pro.requestsPerWindow).toBe(5000);
    expect(pro.windowSeconds).toBe(3600);
    expect(pro.burstAllowance).toBe(1.2);

    const effectivePro = Math.floor(pro.requestsPerWindow * pro.burstAllowance);
    expect(effectivePro).toBe(6000);
  });
});

describe('sliding window limiter logic', () => {
  it('returns allowed result with decrementing remaining count', async () => {
    vi.spyOn(redis, 'script').mockResolvedValue('dummy-sha');
    vi.spyOn(redis, 'evalsha').mockResolvedValueOnce([1, 100, 99, 1720000000, 0]);

    resetScriptSha();
    const result = await checkRateLimit({
      keyId: 'test-key-1',
      limit: 100,
      windowSeconds: 3600,
    });

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(99);
    expect(result.resetAt).toBe(1720000000);
    expect(result.retryAfter).toBeUndefined();
  });

  it('aggregates rate limits at org level when orgId is provided', async () => {
    vi.spyOn(redis, 'script').mockResolvedValue('dummy-sha');
    const evalSpy = vi.spyOn(redis, 'evalsha').mockResolvedValueOnce([1, 100, 95, 1720000000, 0]);

    resetScriptSha();
    const result = await checkRateLimit({
      orgId: 'org-abc',
      keyId: 'key-xyz',
      limit: 100,
      windowSeconds: 3600,
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(95);
    // Verifies that Redis receives the org bucket key `rate:org:org-abc`
    expect(evalSpy).toHaveBeenCalledWith(
      'dummy-sha',
      1,
      'rate:org:org-abc',
      '3600000',
      '100',
      expect.any(String),
      '0',
    );
  });

  it('returns 429 rate_limited result when limit is exceeded', async () => {
    vi.spyOn(redis, 'script').mockResolvedValue('dummy-sha');
    vi.spyOn(redis, 'evalsha').mockResolvedValueOnce([0, 100, 0, 1720000042, 42]);

    resetScriptSha();
    const result = await checkRateLimit({
      keyId: 'test-key-1',
      limit: 100,
      windowSeconds: 3600,
    });

    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(0);
    expect(result.resetAt).toBe(1720000042);
    expect(result.retryAfter).toBe(42);
  });

  it('reloads script when Redis returns NOSCRIPT', async () => {
    vi.spyOn(redis, 'script').mockResolvedValue('new-sha');
    vi.spyOn(redis, 'evalsha')
      .mockRejectedValueOnce(new Error('NOSCRIPT No matching script'))
      .mockResolvedValueOnce([1, 100, 50, 1720000000, 0]);

    resetScriptSha();
    const result = await checkRateLimit({
      keyId: 'test-key-2',
      limit: 100,
      windowSeconds: 3600,
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(50);
  });

  it('fails open when Redis encounters an error so traffic is not dropped', async () => {
    vi.spyOn(redis, 'script').mockRejectedValueOnce(new Error('Connection refused'));

    resetScriptSha();
    const result = await checkRateLimit({
      keyId: 'test-key-failopen',
      limit: 100,
      windowSeconds: 3600,
    });

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(99);
    expect(result.retryAfter).toBeUndefined();
  });
});

describe('sliding window algorithm boundary simulation', () => {
  it('correctly models sliding window eviction and Retry-After calculation', () => {
    const windowMs = 60_000; // 1 minute window
    const limit = 3;
    let entries: { score: number; member: string }[] = [];

    function simulateRequest(nowMs: number, memberId: string) {
      // 1. Remove entries older than (nowMs - windowMs)
      const clearBefore = nowMs - windowMs;
      entries = entries.filter((e) => e.score > clearBefore);

      // 2. Count requests currently in sliding window
      const count = entries.length;
      if (count < limit) {
        entries.push({ score: nowMs, member: memberId });
        const remaining = limit - count - 1;
        const resetAt = Math.ceil((nowMs + windowMs) / 1000);
        return { allowed: true, limit, remaining, resetAt, retryAfter: 0 };
      } else {
        const oldest = entries[0];
        const oldestMs = oldest?.score ?? nowMs;
        const earliestFreeMs = oldestMs + windowMs;
        const retryAfter = Math.max(1, Math.ceil((earliestFreeMs - nowMs) / 1000));
        const resetAt = Math.ceil(earliestFreeMs / 1000);
        return { allowed: false, limit, remaining: 0, resetAt, retryAfter };
      }
    }

    // t = 10,000: request 1 allowed (remaining: 2)
    const r1 = simulateRequest(10_000, 'req1');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    // t = 20,000: request 2 allowed (remaining: 1)
    const r2 = simulateRequest(20_000, 'req2');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    // t = 30,000: request 3 allowed (remaining: 0)
    const r3 = simulateRequest(30_000, 'req3');
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // t = 40,000: request 4 throttled (limit 3 exceeded)
    // Earliest free is req1 at (10,000 + 60,000 = 70,000)
    // retryAfter = ceil((70,000 - 40,000) / 1000) = 30s
    const r4 = simulateRequest(40_000, 'req4');
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfter).toBe(30);

    // t = 70,001: req1 has slid out of window (70,001 - 60,000 = 10,001 > 10,000)
    // Request 5 is admitted!
    const r5 = simulateRequest(70_001, 'req5');
    expect(r5.allowed).toBe(true);
    expect(r5.remaining).toBe(0);
  });
});
