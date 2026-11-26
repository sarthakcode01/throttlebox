import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { requestLogs } from '../../src/db/schema.js';
import { flushAll } from '../../src/analytics/ingest.js';
import {
  buildMockUrl,
  runPlaygroundRequest,
  sanitizeRequestHeaders,
  truncateToBytes,
} from '../../src/playground/runner.js';
import {
  INTERNAL_AUTH_HEADER,
  INTERNAL_KEY_ID_HEADER,
  internalAuthHeaders,
  isInternalToken,
} from '../../src/playground/internalAuth.js';
import { createApiKey, signUp, startApp, type Client, type TestApp } from '../helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
});

const OFF = {
  latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
  errors: { enabled: false, rate5xx: 0, rate429: 0, statusCodes: [500] },
  partition: { enabled: false, dropRate: 0 },
};

async function setChaos(owner: Client, over: Record<string, unknown>) {
  const res = await owner.put('/api/chaos').send({ isEnabled: true, ...OFF, ...over });
  expect(res.status).toBe(200);
}

describe('pure helpers', () => {
  it('buildMockUrl encodes the slug, normalises the path and appends the query', () => {
    expect(buildMockUrl('ecommerce', '/products/42')).toBe('/mock/ecommerce/products/42');
    expect(buildMockUrl('ecommerce', 'products')).toBe('/mock/ecommerce/products');
    expect(buildMockUrl('a b', '/x', { page: '2', q: 'a&b' })).toBe('/mock/a%20b/x?page=2&q=a%26b');
  });

  it('sanitizeRequestHeaders drops credentials, hop-by-hop and internal headers, lowercases the rest', () => {
    const out = sanitizeRequestHeaders({
      Authorization: 'Bearer sk_live_AAAAAAAAAAAA_' + 'b'.repeat(32),
      Cookie: 'a=b',
      Host: 'evil',
      'X-CSRF-Token': 'x',
      'X-Throttlebox-Internal': 'spoof',
      'x-throttlebox-key-id': 'spoof',
      'X-Forwarded-For': '1.2.3.4',
      'X-Custom': 'keep',
      Accept: 'application/json',
    });
    expect(out).toEqual({ 'x-custom': 'keep', accept: 'application/json' });
  });

  it('sanitizeRequestHeaders redacts a raw key pasted into a header value', () => {
    const key = 'sk_live_' + 'A'.repeat(12) + '_' + 'b'.repeat(32);
    expect(sanitizeRequestHeaders({ 'x-note': `use ${key}` })['x-note']).toBe('use sk_***');
  });

  it('truncateToBytes keeps short text and cuts long text on a character boundary', () => {
    expect(truncateToBytes('hello', 10)).toEqual({ text: 'hello', truncated: false });
    const cut = truncateToBytes('héllo wörld', 3); // é is 2 bytes: h(1)+é(2)=3
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe('hé');
    const mid = truncateToBytes('aé', 2); // would split é
    expect(mid.text).toBe('a');
    expect(Buffer.byteLength(mid.text)).toBeLessThanOrEqual(2);
  });
});

describe('internal authentication', () => {
  it('issues a long, stable token and verifies it in constant time', () => {
    const token = internalAuthHeaders('any-key-id')[INTERNAL_AUTH_HEADER];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(internalAuthHeaders('any-key-id')[INTERNAL_AUTH_HEADER]).toBe(token);
    expect(isInternalToken(token)).toBe(true);
    expect(isInternalToken('nope')).toBe(false);
    expect(isInternalToken('')).toBe(false);
    expect(isInternalToken(undefined)).toBe(false);
    expect(isInternalToken(['x'])).toBe(false);
  });

  it('an outside caller cannot use the internal headers to act as a key', async () => {
    const owner = await signUp(t, 'pg-internal');
    const key = await createApiKey(owner);

    const noToken = await request(t.server)
      .get('/mock/ecommerce/products/1')
      .set(INTERNAL_KEY_ID_HEADER, key.id);
    expect(noToken.status).toBe(401);

    const wrongToken = await request(t.server)
      .get('/mock/ecommerce/products/1')
      .set(INTERNAL_AUTH_HEADER, 'f'.repeat(64))
      .set(INTERNAL_KEY_ID_HEADER, key.id);
    expect(wrongToken.status).toBe(401);
  });

  it('the right token with an unknown key id is still 401, not a bypass', async () => {
    const res = await request(t.server)
      .get('/mock/ecommerce/products/1')
      .set(INTERNAL_AUTH_HEADER, internalAuthHeaders('x')[INTERNAL_AUTH_HEADER] as string)
      .set(INTERNAL_KEY_ID_HEADER, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(401);
  });

  it('the right token without a key id is 401', async () => {
    const res = await request(t.server)
      .get('/mock/ecommerce/products/1')
      .set(INTERNAL_AUTH_HEADER, internalAuthHeaders('x')[INTERNAL_AUTH_HEADER] as string);
    expect(res.status).toBe(401);
  });
});

describe('runPlaygroundRequest through the real pipeline', () => {
  it('returns the same body an external caller gets', async () => {
    const owner = await signUp(t, 'pg-run');
    const key = await createApiKey(owner);
    const run = await runPlaygroundRequest(t.app, {
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET',
      serviceSlug: 'ecommerce',
      path: '/products/42',
    });
    const real = await request(t.server)
      .get('/mock/ecommerce/products/42')
      .set('Authorization', `Bearer ${key.key}`);
    expect(run.outcome).toBe('ok');
    expect(run.status).toBe(200);
    expect(JSON.parse(run.body)).toEqual(real.body);
    expect(run.headers['x-ratelimit-limit']).toBe('100');
  });

  it('enforces the key’s real scopes: a read-only key cannot POST', async () => {
    const owner = await signUp(t, 'pg-scope');
    const ro = await createApiKey(owner, { scopes: ['mock:read'] });
    const run = await runPlaygroundRequest(t.app, {
      orgId: owner.orgId,
      keyId: ro.id,
      method: 'POST',
      serviceSlug: 'ecommerce',
      path: '/orders',
      body: '{}',
    });
    expect(run.status).toBe(403);
  });

  it('fails closed for a revoked key', async () => {
    const owner = await signUp(t, 'pg-revoked');
    const key = await createApiKey(owner);
    await owner.post(`/api/keys/${key.id}/revoke`);
    const run = await runPlaygroundRequest(t.app, {
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET',
      serviceSlug: 'ecommerce',
      path: '/products/1',
    });
    expect(run.status).toBe(401);
  });

  it('applies the plan rate limit: the 101st playground request is a 429', async () => {
    const owner = await signUp(t, 'pg-ratelimit');
    const key = await createApiKey(owner);
    const send = () =>
      runPlaygroundRequest(t.app, {
        orgId: owner.orgId,
        keyId: key.id,
        method: 'GET',
        serviceSlug: 'ecommerce',
        path: '/products/1',
      });
    for (let i = 0; i < 100; i++) expect((await send()).status).toBe(200);
    const over = await send();
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
  });

  it('is subject to chaos: an injected 503 is captured with its marker header', async () => {
    const owner = await signUp(t, 'pg-chaos');
    const key = await createApiKey(owner);
    await setChaos(owner, {
      errors: { enabled: true, rate5xx: 1, rate429: 0, statusCodes: [503] },
    });
    const run = await runPlaygroundRequest(t.app, {
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET',
      serviceSlug: 'ecommerce',
      path: '/products/1',
    });
    expect(run.status).toBe(503);
    expect(run.headers['x-throttlebox-chaos-injected']).toBe('true');
  });

  it('reflects injected latency in the measured duration', async () => {
    const owner = await signUp(t, 'pg-latency');
    const key = await createApiKey(owner);
    await setChaos(owner, {
      latency: { enabled: true, distribution: 'fixed', meanMs: 200, stddevMs: 0 },
    });
    const run = await runPlaygroundRequest(t.app, {
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET',
      serviceSlug: 'ecommerce',
      path: '/products/1',
    });
    expect(run.durationMs).toBeGreaterThanOrEqual(190);
  });

  it('reports a chaos network partition as `dropped` immediately instead of hanging', async () => {
    const owner = await signUp(t, 'pg-drop');
    const key = await createApiKey(owner);
    await setChaos(owner, { partition: { enabled: true, dropRate: 1 } });
    const started = Date.now();
    const run = await runPlaygroundRequest(t.app, {
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET',
      serviceSlug: 'ecommerce',
      path: '/products/1',
    });
    expect(run.outcome).toBe('dropped');
    expect(run.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('times out a request that never answers', async () => {
    const owner = await signUp(t, 'pg-timeout');
    const key = await createApiKey(owner);
    await setChaos(owner, {
      latency: { enabled: true, distribution: 'fixed', meanMs: 3000, stddevMs: 0 },
    });
    const run = await runPlaygroundRequest(
      t.app,
      {
        orgId: owner.orgId,
        keyId: key.id,
        method: 'GET',
        serviceSlug: 'ecommerce',
        path: '/products/1',
      },
      { timeoutMs: 300 },
    );
    expect(run.outcome).toBe('error');
    expect(JSON.parse(run.body).error).toBe('timeout');
  });

  it('writes telemetry like any other call, so it appears in analytics', async () => {
    const owner = await signUp(t, 'pg-telemetry');
    const key = await createApiKey(owner);
    await runPlaygroundRequest(t.app, {
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET',
      serviceSlug: 'ecommerce',
      path: '/products/7',
    });
    await new Promise((r) => setTimeout(r, 100));
    await flushAll();
    const rows = await db.select().from(requestLogs).where(eq(requestLogs.orgId, owner.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('/mock/ecommerce/products/7');
    expect(rows[0]!.keyId).toBe(key.id);
  });

  it('truncates a response larger than the cap and flags it', async () => {
    const owner = await signUp(t, 'pg-trunc');
    const key = await createApiKey(owner);
    const svc = await owner.post('/api/mock/services').send({ name: 'Big', slug: 'big' });
    await owner.post(`/api/mock/services/${svc.body.service.id}/routes`).send({
      method: 'GET',
      path: '/blob',
      responseTemplate: { data: 'x'.repeat(80_000) },
    });
    const run = await runPlaygroundRequest(t.app, {
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET',
      serviceSlug: 'big',
      path: '/blob',
    });
    expect(run.status).toBe(200);
    expect(run.truncated).toBe(true);
    expect(Buffer.byteLength(run.body)).toBeLessThanOrEqual(64 * 1024);
  });

  it('strips set-cookie from captured response headers', async () => {
    const owner = await signUp(t, 'pg-cookie');
    const key = await createApiKey(owner);
    const svc = await owner.post('/api/mock/services').send({ name: 'Ck', slug: 'ck' });
    await owner.post(`/api/mock/services/${svc.body.service.id}/routes`).send({
      method: 'GET',
      path: '/c',
      responseTemplate: { ok: true },
      responseHeaders: { 'Set-Cookie': 'session=abc', 'X-Keep': '1' },
    });
    const run = await runPlaygroundRequest(t.app, {
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET',
      serviceSlug: 'ck',
      path: '/c',
    });
    expect(run.headers['set-cookie']).toBeUndefined();
    expect(run.headers['x-keep']).toBe('1');
  });
});
