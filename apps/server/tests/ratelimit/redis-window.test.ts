import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkRateLimit } from '../../src/ratelimit/limiter.js';
import { redis } from '../../src/db/redis.js';

/**
 * The sliding window against a REAL Redis and the real Lua script.
 * Time is injected through `simulatedNowMs`, so boundaries are exact and
 * the tests do not sleep.
 */

const used: string[] = [];
function newOrg(): string {
  const id = randomUUID();
  used.push(`rate:org:${id}`);
  return id;
}

afterEach(async () => {
  if (used.length) await redis.del(...used.splice(0));
});

const T0 = 1_800_000_000_000; // arbitrary fixed epoch ms
const WINDOW = 60; // seconds

function call(orgId: string, limit: number, atMs: number) {
  return checkRateLimit({ orgId, limit, windowSeconds: WINDOW, simulatedNowMs: atMs });
}

describe('exact-boundary enforcement', () => {
  it('allows exactly `limit` requests and rejects the next one', async () => {
    const org = newOrg();
    for (let i = 0; i < 5; i++) {
      const r = await call(org, 5, T0 + i);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(5 - i - 1);
      expect(r.limit).toBe(5);
    }
    const denied = await call(org, 5, T0 + 10);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('does not count a rejected request against the window', async () => {
    const org = newOrg();
    await call(org, 1, T0);
    for (let i = 1; i <= 5; i++) expect((await call(org, 1, T0 + i)).allowed).toBe(false);
    // Once the single accepted request ages out, capacity returns immediately.
    expect((await call(org, 1, T0 + WINDOW * 1000 + 1)).allowed).toBe(true);
  });
});

describe('window sliding and expiry', () => {
  it('frees capacity as the oldest entries leave the window (true sliding, not fixed)', async () => {
    const org = newOrg();
    await call(org, 2, T0); // A
    await call(org, 2, T0 + 30_000); // B
    expect((await call(org, 2, T0 + 40_000)).allowed).toBe(false);

    // 60s after A: A has expired, B has not -> exactly one slot is free.
    const afterA = T0 + WINDOW * 1000 + 1;
    expect((await call(org, 2, afterA)).allowed).toBe(true);
    expect((await call(org, 2, afterA + 1)).allowed).toBe(false);
  });

  it('reports Retry-After as the time until the oldest entry expires', async () => {
    const org = newOrg();
    await call(org, 1, T0);
    const denied = await call(org, 1, T0 + 20_000);
    expect(denied.allowed).toBe(false);
    // Oldest expires at T0 + 60s; we are at +20s => 40s.
    expect(denied.retryAfter).toBe(40);
    expect(denied.resetAt).toBe(Math.ceil((T0 + WINDOW * 1000) / 1000));
  });

  it('starts completely fresh after a full idle window', async () => {
    const org = newOrg();
    for (let i = 0; i < 3; i++) await call(org, 3, T0 + i);
    expect((await call(org, 3, T0 + 10)).allowed).toBe(false);
    const later = await call(org, 3, T0 + WINDOW * 1000 * 2);
    expect(later.allowed).toBe(true);
    expect(later.remaining).toBe(2);
  });

  it('sets a TTL on the bucket so idle orgs do not leak memory', async () => {
    const org = newOrg();
    await checkRateLimit({ orgId: org, limit: 5, windowSeconds: WINDOW }); // real Redis clock
    const ttl = await redis.pttl(`rate:org:${org}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(WINDOW * 1000);
  });
});

describe('isolation and concurrency', () => {
  it('keeps organizations in separate buckets', async () => {
    const a = newOrg();
    const b = newOrg();
    await call(a, 1, T0);
    expect((await call(a, 1, T0 + 1)).allowed).toBe(false);
    expect((await call(b, 1, T0 + 1)).allowed).toBe(true);
  });

  it('is atomic under a concurrent burst: exactly `limit` of N parallel requests win', async () => {
    const org = newOrg();
    const limit = 20;
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        checkRateLimit({ orgId: org, limit, windowSeconds: WINDOW }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(limit);
    expect(results.filter((r) => !r.allowed)).toHaveLength(80);
    expect(await redis.zcard(`rate:org:${org}`)).toBe(limit);
  });

  it('aggregates across keys of the same org (keys cannot multiply the quota)', async () => {
    const org = newOrg();
    const r1 = await checkRateLimit({
      orgId: org,
      keyId: 'k1',
      limit: 2,
      windowSeconds: WINDOW,
      simulatedNowMs: T0,
    });
    const r2 = await checkRateLimit({
      orgId: org,
      keyId: 'k2',
      limit: 2,
      windowSeconds: WINDOW,
      simulatedNowMs: T0 + 1,
    });
    const r3 = await checkRateLimit({
      orgId: org,
      keyId: 'k3',
      limit: 2,
      windowSeconds: WINDOW,
      simulatedNowMs: T0 + 2,
    });
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, false]);
  });
});
