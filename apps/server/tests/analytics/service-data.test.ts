import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { orgWebhooks, requestLogs } from '../../src/db/schema.js';
import {
  getErrorsBreakdown,
  getLatencySeries,
  getOverview,
  getRecentLogs,
  getUsageSeries,
} from '../../src/analytics/service.js';
import { checkOrgQuotas } from '../../src/analytics/quotaMonitor.js';
import { updateOrgPlan, invalidateOrgPlan } from '../../src/ratelimit/tier.js';
import { createTestOrg, destroyTestOrg, type TestOrg } from '../keys/helpers.js';

let org: TestOrg;
let emptyOrg: TestOrg;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeAll(async () => {
  org = await createTestOrg('analytics-data');
  emptyOrg = await createTestOrg('analytics-empty');

  const rows = [
    { latencyMs: 10, statusCode: 200, path: '/mock/s/a', rateLimited: false, m: 5 },
    { latencyMs: 20, statusCode: 200, path: '/mock/s/a', rateLimited: false, m: 4 },
    { latencyMs: 30, statusCode: 404, path: '/mock/s/missing', rateLimited: false, m: 3 },
    { latencyMs: 40, statusCode: 429, path: '/mock/s/a', rateLimited: true, m: 2 },
    { latencyMs: 100, statusCode: 500, path: '/mock/s/boom', rateLimited: false, m: 1 },
  ];
  await db.insert(requestLogs).values(
    rows.map((r, i) => ({
      time: minutesAgo(r.m),
      orgId: org.orgId,
      method: 'GET',
      path: r.path,
      statusCode: r.statusCode,
      latencyMs: r.latencyMs,
      rateLimited: r.rateLimited,
      traceId: `trace-${i}`,
    })),
  );
});

afterAll(async () => {
  await db.delete(requestLogs).where(eq(requestLogs.orgId, org.orgId));
  await destroyTestOrg(org);
  await destroyTestOrg(emptyOrg);
});

describe('analytics queries over real hypertable data', () => {
  it('overview: totals, error rate, throttled count and p95', async () => {
    const o = await getOverview(org.orgId, '1h');
    expect(o.totalRequests).toBe(5);
    // 404 + 429 + 500 are >= 400 -> 3/5 = 60%
    expect(o.errorRate).toBe(60);
    expect(o.throttledRequests).toBe(1);
    // percentile_cont(0.95) over [10,20,30,40,100] = 88
    expect(o.p95LatencyMs).toBe(88);
    expect(o.activeKeysCount).toBe(0);
  });

  it('overview for an org with no traffic is all zeros, not an error', async () => {
    const o = await getOverview(emptyOrg.orgId, '24h');
    expect(o).toEqual({
      totalRequests: 0,
      errorRate: 0,
      p95LatencyMs: 0,
      throttledRequests: 0,
      activeKeysCount: 0,
    });
  });

  it('errors breakdown buckets statuses and ranks the failing paths', async () => {
    const e = await getErrorsBreakdown(org.orgId, '1h');
    expect(e.status2xx).toBe(2);
    expect(e.status4xx).toBe(1);
    expect(e.status429).toBe(1);
    expect(e.status5xx).toBe(1);
    expect(e.topErrorPaths.length).toBe(3);
    expect(e.topErrorPaths.map((p) => p.statusCode).sort()).toEqual([404, 429, 500]);
  });

  it('usage series sums to the number of requests', async () => {
    const series = await getUsageSeries(org.orgId, '1h');
    expect(series.reduce((a, b) => a + b.requests, 0)).toBe(5);
    expect(series.reduce((a, b) => a + b.errors, 0)).toBe(3);
    expect(series.reduce((a, b) => a + b.throttled, 0)).toBe(1);
  });

  it('latency series reports ordered percentiles', async () => {
    const series = await getLatencySeries(org.orgId, '1h');
    expect(series.length).toBeGreaterThan(0);
    for (const b of series) {
      expect(b.p50).toBeLessThanOrEqual(b.p95);
      expect(b.p95).toBeLessThanOrEqual(b.p99);
    }
  });

  it('recent logs are newest-first, paginated, and the limit is clamped', async () => {
    const page1 = await getRecentLogs(org.orgId, 2, 0);
    expect(page1.total).toBe(5);
    expect(page1.logs).toHaveLength(2);
    expect(page1.logs[0]!.traceId).toBe('trace-4'); // 1 minute ago = newest

    const page3 = await getRecentLogs(org.orgId, 2, 4);
    expect(page3.logs).toHaveLength(1);
    expect(page3.logs[0]!.traceId).toBe('trace-0');

    expect((await getRecentLogs(org.orgId, 10_000, 0)).logs).toHaveLength(5);
    expect((await getRecentLogs(org.orgId, 0, 0)).logs).toHaveLength(1); // clamped to >= 1
  });

  it('never leaks another organization’s rows', async () => {
    const other = await getRecentLogs(emptyOrg.orgId, 50, 0);
    expect(other.total).toBe(0);
    expect(other.logs).toEqual([]);
  });
});

describe('quota monitor thresholds', () => {
  const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));

  afterEach(async () => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
    await db.delete(orgWebhooks).where(eq(orgWebhooks.orgId, org.orgId));
    await db.delete(requestLogs).where(eq(requestLogs.orgId, org.orgId));
    await invalidateOrgPlan(org.orgId);
  });

  async function seedUsage(count: number) {
    await db.delete(requestLogs).where(eq(requestLogs.orgId, org.orgId));
    await db.insert(requestLogs).values(
      Array.from({ length: count }, (_, i) => ({
        time: minutesAgo(1),
        orgId: org.orgId,
        method: 'GET',
        path: '/mock/s/a',
        statusCode: 200,
        latencyMs: 5,
        traceId: `q-${i}`,
      })),
    );
  }

  async function addHook() {
    const [hook] = await db
      .insert(orgWebhooks)
      .values({ orgId: org.orgId, url: 'https://hooks.example.com/quota', secret: 'whsec_test' })
      .returning();
    return hook!;
  }

  async function lastAlerted(id: string) {
    const [row] = await db.select().from(orgWebhooks).where(eq(orgWebhooks.id, id));
    return row!.lastAlertedThreshold;
  }

  it('does nothing below 80% of the plan', async () => {
    vi.stubGlobal('fetch', fetchSpy);
    await updateOrgPlan(org.orgId, 'free'); // limit 100
    const hook = await addHook();
    await seedUsage(79);
    await checkOrgQuotas([org.orgId]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await lastAlerted(hook.id)).toBeNull();
  });

  it('fires once at 80%, not again on repeat checks, then at 100%', async () => {
    vi.stubGlobal('fetch', fetchSpy);
    await updateOrgPlan(org.orgId, 'free');
    const hook = await addHook();

    await seedUsage(80);
    await checkOrgQuotas([org.orgId]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await lastAlerted(hook.id)).toBe(80);

    await checkOrgQuotas([org.orgId]);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // deduped

    await seedUsage(100);
    await checkOrgQuotas([org.orgId]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await lastAlerted(hook.id)).toBe(100);

    const [, init] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Throttlebox-Event']).toBe('quota.threshold_reached');
    expect(headers['X-Throttlebox-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    const body = JSON.parse(init.body as string);
    expect(body.data.threshold).toBe(100);
    expect(body.data.limit).toBe(100);
  });

  it('re-arms when usage drops back under the threshold', async () => {
    vi.stubGlobal('fetch', fetchSpy);
    await updateOrgPlan(org.orgId, 'free');
    const hook = await addHook();
    await seedUsage(90);
    await checkOrgQuotas([org.orgId]);
    expect(await lastAlerted(hook.id)).toBe(80);

    await seedUsage(5);
    await checkOrgQuotas([org.orgId]);
    expect(await lastAlerted(hook.id)).toBeNull();
  });

  it('ignores inactive webhooks', async () => {
    vi.stubGlobal('fetch', fetchSpy);
    await updateOrgPlan(org.orgId, 'free');
    const hook = await addHook();
    await db.update(orgWebhooks).set({ isActive: false }).where(eq(orgWebhooks.id, hook.id));
    await seedUsage(100);
    await checkOrgQuotas([org.orgId]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('scales the threshold with the plan (pro has a 6000 request ceiling)', async () => {
    vi.stubGlobal('fetch', fetchSpy);
    await updateOrgPlan(org.orgId, 'pro');
    await addHook();
    await seedUsage(100); // 100/6000 is nowhere near 80%
    await checkOrgQuotas([org.orgId]);
    expect(fetchSpy).not.toHaveBeenCalled();
    await updateOrgPlan(org.orgId, 'free');
  });
});
