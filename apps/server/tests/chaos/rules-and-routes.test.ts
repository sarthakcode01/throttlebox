import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { db } from '../../src/db/client.js';
import { chaosRules } from '../../src/db/schema.js';
import { resolveChaosRule, invalidateChaosRule } from '../../src/chaos/cache.js';
import {
  createApiKey,
  runMemberCleanup,
  signInAsMember,
  signUp,
  startApp,
  type Client,
  type TestApp,
} from '../helpers/app.js';

let t: TestApp;
let owner: Client;
let serviceId: string;
let keyId: string;

const DISABLED = {
  latency: { enabled: false, distribution: 'normal', meanMs: 200, stddevMs: 50 },
  errors: { enabled: false, rate5xx: 0, rate429: 0, statusCodes: [500] },
  partition: { enabled: false, dropRate: 0 },
};

function rule(over: Record<string, unknown> = {}) {
  return { isEnabled: true, ...DISABLED, ...over };
}

beforeAll(async () => {
  t = await startApp();
  owner = await signUp(t, 'chaos');
  const svc = await owner.get('/api/mock/services');
  serviceId = svc.body.services.find((s: { slug: string }) => s.slug === 'ecommerce').id;
  keyId = (await createApiKey(owner)).id;
});

afterEach(async () => {
  await db.delete(chaosRules).where(eq(chaosRules.orgId, owner.orgId));
  await invalidateChaosRule(owner.orgId);
});

afterAll(async () => {
  await t.close();
  await runMemberCleanup();
});

describe('rule hierarchy (resolveChaosRule, real DB + Redis)', () => {
  it('returns null when nothing is configured', async () => {
    expect(await resolveChaosRule(owner.orgId, serviceId, keyId)).toBeNull();
  });

  it('falls back to the org default', async () => {
    await owner.put('/api/chaos').send(rule());
    const r = await resolveChaosRule(owner.orgId, serviceId, keyId);
    expect(r?.serviceId).toBeNull();
    expect(r?.keyId).toBeNull();
  });

  it('prefers service+key over service, over key, over org', async () => {
    await owner.put('/api/chaos').send(rule());
    await owner.put('/api/chaos').send(rule({ keyId }));
    await owner.put('/api/chaos').send(rule({ serviceId }));
    await owner.put('/api/chaos').send(rule({ serviceId, keyId }));

    let r = await resolveChaosRule(owner.orgId, serviceId, keyId);
    expect([r?.serviceId, r?.keyId]).toEqual([serviceId, keyId]);

    await owner.delete(`/api/chaos?serviceId=${serviceId}&keyId=${keyId}`);
    r = await resolveChaosRule(owner.orgId, serviceId, keyId);
    expect([r?.serviceId, r?.keyId]).toEqual([serviceId, null]);

    await owner.delete(`/api/chaos?serviceId=${serviceId}`);
    r = await resolveChaosRule(owner.orgId, serviceId, keyId);
    expect([r?.serviceId, r?.keyId]).toEqual([null, keyId]);

    await owner.delete(`/api/chaos?keyId=${keyId}`);
    r = await resolveChaosRule(owner.orgId, serviceId, keyId);
    expect([r?.serviceId, r?.keyId]).toEqual([null, null]);
  });

  it('a disabled specific rule overrides an enabled org default (exemption)', async () => {
    await owner.put('/api/chaos').send(rule());
    await owner.put('/api/chaos').send(rule({ serviceId, isEnabled: false }));
    const r = await resolveChaosRule(owner.orgId, serviceId, null);
    expect(r?.isEnabled).toBe(false);
  });

  it('serves a stale rule from cache until invalidated, then picks up the change', async () => {
    await owner.put('/api/chaos').send(rule({ isEnabled: false }));
    expect((await resolveChaosRule(owner.orgId))?.isEnabled).toBe(false);
    // Write straight to the DB, bypassing the API (and its invalidation).
    await db.update(chaosRules).set({ isEnabled: true }).where(eq(chaosRules.orgId, owner.orgId));
    expect((await resolveChaosRule(owner.orgId))?.isEnabled).toBe(false); // cached
    await invalidateChaosRule(owner.orgId);
    expect((await resolveChaosRule(owner.orgId))?.isEnabled).toBe(true);
  });
});

describe('GET/PUT/DELETE /api/chaos', () => {
  it('GET returns a disabled default rule when none exists', async () => {
    const res = await owner.get('/api/chaos');
    expect(res.status).toBe(200);
    expect(res.body.defaultRule.isEnabled).toBe(false);
    expect(res.body.rules).toEqual([]);
  });

  it('PUT creates then updates the same scoped rule (upsert, no duplicates)', async () => {
    const a = await owner
      .put('/api/chaos')
      .send(rule({ errors: { ...DISABLED.errors, enabled: true, rate5xx: 0.1 } }));
    expect(a.status).toBe(200);
    const b = await owner
      .put('/api/chaos')
      .send(rule({ errors: { ...DISABLED.errors, enabled: true, rate5xx: 0.5 } }));
    expect(b.body.rule.id).toBe(a.body.rule.id);
    expect(b.body.rule.errors.rate5xx).toBe(0.5);
    const list = await owner.get('/api/chaos');
    expect(list.body.rules).toHaveLength(1);
  });

  it.each([
    ['rate above 1', { errors: { ...DISABLED.errors, rate5xx: 1.5 } }],
    ['negative drop rate', { partition: { enabled: true, dropRate: -0.1 } }],
    ['latency above 30s', { latency: { ...DISABLED.latency, meanMs: 40_000 } }],
    ['minMs greater than maxMs', { latency: { ...DISABLED.latency, minMs: 500, maxMs: 100 } }],
    ['non-uuid serviceId', { serviceId: 'nope' }],
  ])('rejects %s with 400', async (_l, over) => {
    const res = await owner.put('/api/chaos').send(rule(over));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('refuses to attach a rule to another organization’s service or key (404)', async () => {
    const other = await signUp(t, 'chaos-other');
    const otherSvc = (await other.get('/api/mock/services')).body.services[0].id;
    const otherKey = (await createApiKey(other)).id;
    expect((await owner.put('/api/chaos').send(rule({ serviceId: otherSvc }))).status).toBe(404);
    expect((await owner.put('/api/chaos').send(rule({ keyId: otherKey }))).status).toBe(404);
  });

  it('DELETE removes only the targeted scope', async () => {
    await owner.put('/api/chaos').send(rule());
    await owner.put('/api/chaos').send(rule({ serviceId }));
    await owner.delete(`/api/chaos?serviceId=${serviceId}`);
    const list = await owner.get('/api/chaos');
    expect(list.body.rules).toHaveLength(1);
    expect(list.body.rules[0].serviceId).toBeNull();
  });

  it('POST /chaos/reset disables every rule and zeroes the injections', async () => {
    await owner
      .put('/api/chaos')
      .send(rule({ errors: { ...DISABLED.errors, enabled: true, rate5xx: 1 } }));
    const res = await owner.post('/api/chaos/reset');
    expect(res.status).toBe(200);
    const list = await owner.get('/api/chaos');
    expect(list.body.rules[0].isEnabled).toBe(false);
    expect(list.body.rules[0].errors.rate5xx).toBe(0);
  });
});

describe('access control', () => {
  it('requires authentication', async () => {
    expect((await request(t.server).get('/api/chaos')).status).toBe(401);
  });

  it('viewers cannot read or write chaos; devs can', async () => {
    const viewer = await signInAsMember(t, owner.orgId, 'viewer');
    const dev = await signInAsMember(t, owner.orgId, 'dev');
    expect((await viewer.get('/api/chaos')).status).toBe(403);
    expect((await viewer.put('/api/chaos').send(rule())).status).toBe(403);
    expect((await dev.get('/api/chaos')).status).toBe(200);
    expect((await dev.put('/api/chaos').send(rule())).status).toBe(200);
  });
});

describe('POST /api/chaos/benchmark', () => {
  it('with chaos off, every simulated request succeeds fast', async () => {
    const res = await owner.post('/api/chaos/benchmark').send({ requestCount: 50 });
    expect(res.status).toBe(200);
    expect(res.body.totalRequests).toBe(50);
    expect(res.body.successful).toBe(50);
    expect(res.body.errors5xx + res.body.throttled429 + res.body.dropped).toBe(0);
    expect(res.body.p99LatencyMs).toBeLessThan(50);
    const histTotal = res.body.histogram.reduce(
      (a: number, b: { count: number }) => a + b.count,
      0,
    );
    expect(histTotal).toBe(50);
  });

  it('with 100% 5xx every request fails and counts add up', async () => {
    await owner
      .put('/api/chaos')
      .send(rule({ errors: { ...DISABLED.errors, enabled: true, rate5xx: 1 } }));
    const res = await owner.post('/api/chaos/benchmark').send({ requestCount: 40 });
    expect(res.body.errors5xx).toBe(40);
    expect(res.body.successful).toBe(0);
  });

  it('with 100% partition drop everything is dropped', async () => {
    await owner.put('/api/chaos').send(rule({ partition: { enabled: true, dropRate: 1 } }));
    const res = await owner.post('/api/chaos/benchmark').send({ requestCount: 30 });
    expect(res.body.dropped).toBe(30);
  });

  it('a 5% error rate lands near 5% over many runs (statistical sanity)', async () => {
    await owner
      .put('/api/chaos')
      .send(rule({ errors: { ...DISABLED.errors, enabled: true, rate5xx: 0.05 } }));
    let failures = 0;
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const res = await owner.post('/api/chaos/benchmark').send({ requestCount: 200 });
      failures += res.body.errors5xx;
      total += res.body.totalRequests;
    }
    const rate = failures / total; // 2000 samples, sd ~0.5%
    expect(rate).toBeGreaterThan(0.025);
    expect(rate).toBeLessThan(0.085);
  });

  it('validates request count bounds', async () => {
    expect((await owner.post('/api/chaos/benchmark').send({ requestCount: 5 })).status).toBe(400);
    expect((await owner.post('/api/chaos/benchmark').send({ requestCount: 5000 })).status).toBe(
      400,
    );
  });
});
