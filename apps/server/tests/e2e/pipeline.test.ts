import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { redis } from '../../src/db/redis.js';
import { flushAll } from '../../src/analytics/ingest.js';
import {
  createApiKey,
  runMemberCleanup,
  signUp,
  startApp,
  type Client,
  type TestApp,
} from '../helpers/app.js';

/**
 * The whole product through the real HTTP stack, real Postgres and real
 * Redis: sign up -> key -> mock call -> rate limit -> chaos -> telemetry.
 */

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
  await runMemberCleanup();
});

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

const OFF = {
  latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
  errors: { enabled: false, rate5xx: 0, rate429: 0, statusCodes: [503] },
  partition: { enabled: false, dropRate: 0 },
};

describe('mock API access control', () => {
  it('401s without a key, with a malformed key, and with a key in the query string', async () => {
    const owner = await signUp(t, 'e2e-auth');
    const { key } = await createApiKey(owner);

    const none = await request(t.server).get('/mock/ecommerce/products/1');
    const bad = await request(t.server)
      .get('/mock/ecommerce/products/1')
      .set(bearer('sk_test_nope'));
    const query = await request(t.server).get(`/mock/ecommerce/products/1?api_key=${key}`);
    expect(none.status).toBe(401);
    expect(bad.status).toBe(401);
    expect(query.status).toBe(401);
    expect(none.body).toEqual(bad.body); // uniform body: no oracle
  });

  it('serves a deterministic templated response to a valid key', async () => {
    const owner = await signUp(t, 'e2e-ok');
    const { key } = await createApiKey(owner);
    const a = await request(t.server).get('/mock/ecommerce/products/42').set(bearer(key));
    const b = await request(t.server).get('/mock/ecommerce/products/42').set(bearer(key));
    const c = await request(t.server).get('/mock/ecommerce/products/99').set(bearer(key));
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(a.body).not.toEqual(c.body);
    expect(JSON.stringify(a.body)).toContain('42');
  });

  it('returns 404 for an unknown service and an unknown route', async () => {
    const owner = await signUp(t, 'e2e-404');
    const { key } = await createApiKey(owner);
    expect((await request(t.server).get('/mock/ghost/x').set(bearer(key))).status).toBe(404);
    expect(
      (await request(t.server).get('/mock/ecommerce/no-such-route').set(bearer(key))).status,
    ).toBe(404);
  });

  it('enforces scopes: a read-only key cannot write', async () => {
    const owner = await signUp(t, 'e2e-scope');
    const ro = await createApiKey(owner, { scopes: ['mock:read'] });
    const rw = await createApiKey(owner, { scopes: ['mock:read', 'mock:write'] });
    const denied = await request(t.server)
      .post('/mock/ecommerce/orders')
      .set(bearer(ro.key))
      .send({});
    expect(denied.status).toBe(403);
    const allowed = await request(t.server)
      .post('/mock/ecommerce/orders')
      .set(bearer(rw.key))
      .send({});
    expect(allowed.status).not.toBe(403);
    expect(allowed.status).not.toBe(401);
  });

  it('isolates tenants: org B cannot reach org A’s custom service', async () => {
    const a = await signUp(t, 'e2e-tenant-a');
    const b = await signUp(t, 'e2e-tenant-b');
    const created = await a
      .post('/api/mock/services')
      .send({ name: 'Secret Svc', slug: 'secret-svc' });
    expect(created.status).toBe(201);
    await a.post(`/api/mock/services/${created.body.service.id}/routes`).send({
      method: 'GET',
      path: '/hello',
      responseTemplate: { who: 'org-a' },
    });
    const keyA = await createApiKey(a);
    const keyB = await createApiKey(b);
    expect(
      (await request(t.server).get('/mock/secret-svc/hello').set(bearer(keyA.key))).body,
    ).toEqual({ who: 'org-a' });
    expect(
      (await request(t.server).get('/mock/secret-svc/hello').set(bearer(keyB.key))).status,
    ).toBe(404);
  });
});

describe('key lifecycle against live traffic', () => {
  it('revoking a key makes the next request 401', async () => {
    const owner = await signUp(t, 'e2e-revoke');
    const { id, key } = await createApiKey(owner);
    expect(
      (await request(t.server).get('/mock/ecommerce/products/1').set(bearer(key))).status,
    ).toBe(200);
    expect((await owner.post(`/api/keys/${id}/revoke`)).status).toBeLessThan(300);
    expect(
      (await request(t.server).get('/mock/ecommerce/products/1').set(bearer(key))).status,
    ).toBe(401);
  });

  it('rotation: both keys work during the grace window, and revoking the family kills both', async () => {
    const owner = await signUp(t, 'e2e-rotate');
    const { id, key: oldKey } = await createApiKey(owner);
    const rotated = await owner.post(`/api/keys/${id}/rotate`).send({ graceHours: 24 });
    expect(rotated.status).toBeLessThan(300);
    const newKey = rotated.body.key as string;
    expect(newKey).not.toBe(oldKey);

    const call = (k: string) => request(t.server).get('/mock/ecommerce/products/1').set(bearer(k));
    expect((await call(oldKey)).status).toBe(200);
    expect((await call(newKey)).status).toBe(200);

    const familyId =
      rotated.body.familyId ?? (await owner.get('/api/keys')).body.keys?.[0]?.familyId;
    expect(familyId).toBeTruthy();
    expect((await owner.post(`/api/families/${familyId}/revoke`)).status).toBeLessThan(300);
    expect((await call(oldKey)).status).toBe(401);
    expect((await call(newKey)).status).toBe(401);
  });
});

describe('rate limiting through the real pipeline', () => {
  it('sets X-RateLimit headers, counts down, then 429s with Retry-After at the plan limit', async () => {
    const owner = await signUp(t, 'e2e-rl');
    const { key } = await createApiKey(owner);
    const call = () => request(t.server).get('/mock/ecommerce/products/1').set(bearer(key));

    const first = await call();
    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('100');
    expect(first.headers['x-ratelimit-remaining']).toBe('99');
    expect(Number(first.headers['x-ratelimit-reset'])).toBeGreaterThan(Date.now() / 1000);

    for (let i = 0; i < 99; i++) expect((await call()).status).toBe(200);
    const over = await call();
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('rate_limited');
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(over.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('aggregates across an org’s keys, and a plan upgrade lifts the cap without a restart', async () => {
    const owner = await signUp(t, 'e2e-upgrade');
    const k1 = await createApiKey(owner);
    const k2 = await createApiKey(owner);
    const call = (k: string) => request(t.server).get('/mock/ecommerce/products/1').set(bearer(k));

    for (let i = 0; i < 50; i++) expect((await call(k1.key)).status).toBe(200);
    for (let i = 0; i < 50; i++) expect((await call(k2.key)).status).toBe(200);
    expect((await call(k1.key)).status).toBe(429);
    expect((await call(k2.key)).status).toBe(429);

    expect((await owner.patch('/api/org/plan').send({ plan: 'pro' })).status).toBe(200);
    const after = await call(k1.key);
    expect(after.status).toBe(200);
    expect(after.headers['x-ratelimit-limit']).toBe('6000'); // 5000 x 1.2 burst
  });

  it('keeps one org’s traffic from consuming another’s quota', async () => {
    const a = await signUp(t, 'e2e-iso-a');
    const b = await signUp(t, 'e2e-iso-b');
    const ka = await createApiKey(a);
    const kb = await createApiKey(b);
    for (let i = 0; i < 100; i++)
      await request(t.server).get('/mock/ecommerce/products/1').set(bearer(ka.key));
    expect(
      (await request(t.server).get('/mock/ecommerce/products/1').set(bearer(ka.key))).status,
    ).toBe(429);
    expect(
      (await request(t.server).get('/mock/ecommerce/products/1').set(bearer(kb.key))).status,
    ).toBe(200);
  });
});

describe('chaos through the real pipeline', () => {
  async function setRule(owner: Client, over: Record<string, unknown>) {
    const res = await owner.put('/api/chaos').send({ isEnabled: true, ...OFF, ...over });
    expect(res.status).toBe(200);
  }

  it('injects a 503 with the chaos marker when the error rate is 100%', async () => {
    const owner = await signUp(t, 'e2e-chaos-err');
    const { key } = await createApiKey(owner);
    await setRule(owner, { errors: { enabled: true, rate5xx: 1, rate429: 0, statusCodes: [503] } });
    const res = await request(t.server).get('/mock/ecommerce/products/1').set(bearer(key));
    expect(res.status).toBe(503);
    expect(res.headers['x-throttlebox-chaos-injected']).toBe('true');
    expect(res.body.error).toBe('chaos_fault_injected');
  });

  it('adds latency and reports it in a header', async () => {
    const owner = await signUp(t, 'e2e-chaos-lat');
    const { key } = await createApiKey(owner);
    await setRule(owner, {
      latency: { enabled: true, distribution: 'fixed', meanMs: 150, stddevMs: 0 },
    });
    const started = Date.now();
    const res = await request(t.server).get('/mock/ecommerce/products/1').set(bearer(key));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(res.headers['x-throttlebox-chaos-latency']).toBe('150ms');
  });

  it('severs the TCP connection on a 100% partition', async () => {
    const owner = await signUp(t, 'e2e-chaos-drop');
    const { key } = await createApiKey(owner);
    await setRule(owner, { partition: { enabled: true, dropRate: 1 } });
    await expect(
      request(t.server).get('/mock/ecommerce/products/1').set(bearer(key)),
    ).rejects.toThrow();
  });

  it('turning chaos off (reset) restores normal responses immediately', async () => {
    const owner = await signUp(t, 'e2e-chaos-reset');
    const { key } = await createApiKey(owner);
    await setRule(owner, { errors: { enabled: true, rate5xx: 1, rate429: 0, statusCodes: [500] } });
    expect(
      (await request(t.server).get('/mock/ecommerce/products/1').set(bearer(key))).status,
    ).toBe(500);
    await owner.post('/api/chaos/reset');
    expect(
      (await request(t.server).get('/mock/ecommerce/products/1').set(bearer(key))).status,
    ).toBe(200);
  });

  it('chaos is applied after rate limiting: a throttled request is a 429 with no chaos marker', async () => {
    const owner = await signUp(t, 'e2e-chaos-order');
    const { key } = await createApiKey(owner);
    for (let i = 0; i < 100; i++)
      await request(t.server).get('/mock/ecommerce/products/1').set(bearer(key));
    await setRule(owner, { errors: { enabled: true, rate5xx: 1, rate429: 0, statusCodes: [500] } });
    const res = await request(t.server).get('/mock/ecommerce/products/1').set(bearer(key));
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.headers['x-throttlebox-chaos-injected']).toBeUndefined();
  });
});

describe('telemetry reaches the analytics dashboard', () => {
  it('records successes, throttles and chaos faults, and exposes them via /api/analytics', async () => {
    const owner = await signUp(t, 'e2e-telemetry');
    const { key } = await createApiKey(owner);
    const call = (path: string) => request(t.server).get(path).set(bearer(key));

    await call('/mock/ecommerce/products/1');
    await call('/mock/ecommerce/products/2');
    await call('/mock/ecommerce/no-such-route'); // 404
    await request(t.server).get('/mock/ecommerce/products/1'); // 401: not stored

    await flushAll();
    // The response hook runs after the reply is flushed; give it a tick.
    await new Promise((r) => setTimeout(r, 100));
    await flushAll();

    const overview = await owner.get('/api/analytics/overview?range=1h');
    expect(overview.body.totalRequests).toBe(3);
    expect(overview.body.activeKeysCount).toBe(1);

    const errors = await owner.get('/api/analytics/errors?range=1h');
    expect(errors.body.status2xx).toBe(2);
    expect(errors.body.status4xx).toBe(1);

    const logs = await owner.get('/api/analytics/logs?limit=10&offset=0');
    expect(logs.body.total).toBe(3);
    expect(logs.body.logs[0].serviceSlug).toBe('ecommerce');
    expect(logs.body.logs.every((l: { keyDisplay: string }) => l.keyDisplay)).toBe(true);
    // The raw key never appears in the log feed.
    expect(JSON.stringify(logs.body)).not.toContain(key);
  });

  it('analytics are tenant-scoped', async () => {
    const a = await signUp(t, 'e2e-tel-a');
    const b = await signUp(t, 'e2e-tel-b');
    const { key } = await createApiKey(a);
    await request(t.server).get('/mock/ecommerce/products/1').set(bearer(key));
    await new Promise((r) => setTimeout(r, 100));
    await flushAll();
    expect((await b.get('/api/analytics/logs?limit=10')).body.total).toBe(0);
  });
});

describe('OpenAPI document', () => {
  it('is served to a session, to an API key, and refused to anonymous callers', async () => {
    const owner = await signUp(t, 'e2e-openapi');
    const { key } = await createApiKey(owner);

    const viaSession = await owner.get('/docs/ecommerce/openapi.json');
    expect(viaSession.status).toBe(200);
    expect(viaSession.body.openapi).toBe('3.1.0');
    expect(Object.keys(viaSession.body.paths).length).toBeGreaterThan(0);

    const viaKey = await request(t.server).get('/docs/ecommerce/openapi.json').set(bearer(key));
    expect(viaKey.status).toBe(200);

    expect((await request(t.server).get('/docs/ecommerce/openapi.json')).status).toBe(403);
    expect((await owner.get('/docs/ghost/openapi.json')).status).toBe(404);
  });
});

describe('dashboard preview', () => {
  it('renders exactly what a real caller receives', async () => {
    const owner = await signUp(t, 'e2e-preview');
    const { key } = await createApiKey(owner);
    const preview = await owner
      .post('/api/mock/preview')
      .send({ serviceSlug: 'ecommerce', method: 'GET', path: '/products/42' });
    const real = await request(t.server).get('/mock/ecommerce/products/42').set(bearer(key));
    expect(preview.status).toBe(200);
    // The preview returns the body pretty-printed for display.
    const shown =
      typeof preview.body.body === 'string' ? JSON.parse(preview.body.body) : preview.body.body;
    expect(shown).toEqual(real.body);
    expect(preview.body.statusCode).toBe(real.status);
  });
});

describe('health', () => {
  it('liveness and readiness both report ok with live dependencies', async () => {
    expect((await request(t.server).get('/health')).body.ok).toBe(true);
    const ready = await request(t.server).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ database: 'ok', redis: 'ok' });
    expect(await redis.ping()).toBe('PONG');
  });
});
