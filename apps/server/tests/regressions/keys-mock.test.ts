import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { and, eq, isNull } from 'drizzle-orm';
import { buildServer } from '../../src/index.js';
import { db } from '../../src/db/client.js';
import { apiKeyEvents, apiKeys, mockRoutes } from '../../src/db/schema.js';
import { createKey, rotateKey } from '../../src/keys/store.js';
import { verifyKey } from '../../src/keys/verify.js';
import { invalidateCachedKeyById } from '../../src/keys/cache.js';
import {
  createRoute,
  createService,
  invalidateRouterCache,
  MockError,
  updateService,
} from '../../src/mock/services.js';
import {
  createTemplateContext,
  MAX_RENDERED_CHARS,
  MAX_SIZE_ARGUMENT,
  renderTemplate,
} from '../../src/mock/template.js';
import { createSession, CSRF_COOKIE, SESSION_COOKIE } from '../../src/auth/session.js';
import { createTestOrg, destroyTestOrg, type TestOrg } from '../keys/helpers.js';

/**
 * Regression tests for the Phase 2 and Phase 3 fixes in
 * PHASE_WISE_BUG_REPORT.md.
 */

describe('Phase 2 regressions', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('reg-keys');
  });

  afterAll(async () => {
    await destroyTestOrg(org);
  });

  it('2.1: concurrent rotations leave exactly one current key in the family', async () => {
    const created = await createKey({
      orgId: org.orgId,
      name: 'concurrent',
      env: 'test',
      createdBy: org.userId,
    });

    await Promise.all([
      rotateKey({ orgId: org.orgId, keyId: created.id }),
      rotateKey({ orgId: org.orgId, keyId: created.id }),
      rotateKey({ orgId: org.orgId, keyId: created.id }),
    ]);

    const current = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.familyId, created.familyId),
          eq(apiKeys.status, 'active'),
          isNull(apiKeys.graceUntil),
        ),
      );
    expect(current).toHaveLength(1);
  });

  it('2.3: an expired key cannot be rotated', async () => {
    const created = await createKey({
      orgId: org.orgId,
      name: 'expired',
      env: 'test',
      expiresInDays: 1,
      createdBy: org.userId,
    });
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, created.id));
    await invalidateCachedKeyById(created.id);

    await expect(rotateKey({ orgId: org.orgId, keyId: created.id })).rejects.toThrow(/expired/i);
  });

  it('2.4: an unknown public id is looked up in Postgres once, then remembered', async () => {
    const unknown = `sk_test_${'Z'.repeat(4)}${Date.now().toString(36).slice(-8).padStart(8, 'a')}_${'q'.repeat(32)}`;
    const selectSpy = vi.spyOn(db, 'select');

    expect(await verifyKey(unknown)).toBeNull();
    const afterFirst = selectSpy.mock.calls.length;
    expect(await verifyKey(unknown)).toBeNull();
    expect(await verifyKey(unknown)).toBeNull();

    expect(selectSpy.mock.calls.length).toBe(afterFirst);
    selectSpy.mockRestore();
  });

  it('2.5: repeated wrong-secret attempts write one audit row per window', async () => {
    const created = await createKey({
      orgId: org.orgId,
      name: 'audit-dedupe',
      env: 'test',
      createdBy: org.userId,
    });
    const wrong = `${created.key.slice(0, -4)}${created.key.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;

    for (let i = 0; i < 5; i++) {
      expect(await verifyKey(wrong)).toBeNull();
    }

    const events = await db
      .select({ id: apiKeyEvents.id })
      .from(apiKeyEvents)
      .where(and(eq(apiKeyEvents.keyId, created.id), eq(apiKeyEvents.event, 'auth_failed')));
    expect(events).toHaveLength(1);
  });
});

describe('Phase 3 regressions', () => {
  let app: FastifyInstance;
  let server: Server;
  let org: TestOrg;
  let serviceId: string;
  const serviceSlug = `reg-${Date.now().toString(36)}`;
  let key: string;
  let session: { token: string; csrfToken: string };

  const authed = () => ({ Authorization: `Bearer ${key}` });
  const dashboard = () => ({
    Cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrfToken}`,
    'X-CSRF-Token': session.csrfToken,
  });

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    server = app.server;
    org = await createTestOrg('reg-mock');

    const service = await createService(org.orgId, { name: 'Regression', slug: serviceSlug });
    serviceId = service.id;

    await createRoute(org.orgId, serviceId, {
      method: 'GET',
      path: '/echo',
      responseTemplate: {
        auth: '{{headers.authorization}}',
        cookie: '{{headers.cookie}}',
        accept: '{{headers.accept}}',
      },
    });
    await createRoute(org.orgId, serviceId, {
      method: 'GET',
      path: '/items',
      responseTemplate: { name: '{{faker.commerce.productName}}', page: '{{query.page "1"}}' },
    });
    await createRoute(org.orgId, serviceId, {
      method: 'GET',
      path: '/located/:id',
      statusCode: 201,
      responseHeaders: { Location: '/things/{{params.id}}', 'Content-Type': 'text/plain' },
      responseTemplate: { id: '{{params.id}}' },
    });

    const created = await createKey({
      orgId: org.orgId,
      name: 'reg-mock',
      env: 'test',
      scopes: ['mock:read', 'mock:write'],
      createdBy: org.userId,
    });
    key = created.key;
    session = await createSession({ userId: org.userId });
    invalidateRouterCache();
  });

  afterAll(async () => {
    await app.close();
    invalidateRouterCache();
    await destroyTestOrg(org);
  });

  it('3.1: a huge faker argument is clamped and renders fast', () => {
    const context = createTemplateContext({ seed: 1 });
    const started = performance.now();
    const output = renderTemplate('{{faker.string.alpha 20000000}}', context) as string;
    expect(performance.now() - started).toBeLessThan(500);
    expect(output.length).toBeLessThanOrEqual(MAX_SIZE_ARGUMENT);
  });

  it('3.1: value arguments such as number ranges are not clamped', () => {
    const context = createTemplateContext({ seed: 7 });
    const value = renderTemplate('{{faker.number.int min=100000 max=200000}}', context) as number;
    expect(value).toBeGreaterThanOrEqual(100000);
  });

  it('3.1: total rendered output is capped', () => {
    const context = createTemplateContext({ seed: 3 });
    // Wall time is not asserted: it depends on the machine and on what else
    // the test run is doing. Bounded output is what bounds the work.
    const template = Array.from({ length: 5000 }, () => '{{faker.string.alpha 256}}');
    const output = renderTemplate(template, context) as unknown[];
    expect(output.filter((v) => v !== undefined).length).toBeLessThan(5000);
    const produced = output.filter((v) => typeof v === 'string').join('').length;
    expect(produced).toBeLessThanOrEqual(MAX_RENDERED_CHARS + 256);
  });

  it('3.2: a trailing-slash duplicate route is rejected', async () => {
    await expect(
      createRoute(org.orgId, serviceId, { method: 'GET', path: '/items/', responseTemplate: {} }),
    ).rejects.toThrow(MockError);
  });

  it('3.2: a path the router cannot parse is rejected', async () => {
    await expect(
      createRoute(org.orgId, serviceId, {
        method: 'GET',
        path: '/bad/*/tail',
        responseTemplate: {},
      }),
    ).rejects.toThrow(/Invalid route path/);
  });

  it('3.2: a duplicate already in the database does not take the service down', async () => {
    // Insert the colliding row directly, as an older version would have.
    await db.insert(mockRoutes).values({
      serviceId,
      method: 'GET',
      path: '/echo/',
      responseTemplate: {},
    });
    invalidateRouterCache();

    const response = await request(server).get(`/mock/${serviceSlug}/items`).set(authed());
    expect(response.status).toBe(200);
  });

  it('3.3: templates cannot read the Authorization or Cookie headers', async () => {
    const response = await request(server)
      .get(`/mock/${serviceSlug}/echo`)
      .set(authed())
      .set('Cookie', 'throttlebox_session=SECRET')
      .set('Accept', 'application/reg');
    expect(response.status).toBe(200);
    expect(response.body.auth).toBeUndefined();
    expect(response.body.cookie).toBeUndefined();
    expect(response.body.accept).toBe('application/reg');
    expect(response.text).not.toContain(key);
    expect(response.text).not.toContain('SECRET');
  });

  it('3.3: the dashboard preview does not leak the session cookie either', async () => {
    const response = await request(server)
      .post('/api/mock/preview')
      .set(dashboard())
      .send({ serviceSlug, method: 'GET', path: '/echo' });
    expect(response.status).toBe(200);
    expect(response.body.body).not.toContain(session.token);
  });

  it('3.4: invalid and forbidden header names are rejected', async () => {
    const bad = await request(server)
      .post(`/api/mock/services/${serviceId}/routes`)
      .set(dashboard())
      .send({ method: 'GET', path: '/h1', responseHeaders: { 'Bad Name': 'x' } });
    expect(bad.status).toBe(400);

    const cookie = await request(server)
      .post(`/api/mock/services/${serviceId}/routes`)
      .set(dashboard())
      .send({ method: 'GET', path: '/h2', responseHeaders: { 'Set-Cookie': 'a=b' } });
    expect(cookie.status).toBe(400);

    const crlf = await request(server)
      .post(`/api/mock/services/${serviceId}/routes`)
      .set(dashboard())
      .send({ method: 'GET', path: '/h3', responseHeaders: { 'X-Ok': 'a\r\nInjected: 1' } });
    expect(crlf.status).toBe(400);
  });

  it('3.5 / 3.6: header values are templated and a custom Content-Type is kept', async () => {
    const response = await request(server).get(`/mock/${serviceSlug}/located/42`).set(authed());
    expect(response.status).toBe(201);
    expect(response.headers.location).toBe('/things/42');
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('3.15: a different query string is a different resource', async () => {
    const page1 = await request(server).get(`/mock/${serviceSlug}/items?page=1`).set(authed());
    const page2 = await request(server).get(`/mock/${serviceSlug}/items?page=2`).set(authed());
    const again = await request(server).get(`/mock/${serviceSlug}/items?page=2`).set(authed());
    expect(page1.body.name).not.toBe(page2.body.name);
    expect(again.body.name).toBe(page2.body.name);
  });

  it('3.16: the preview accepts a query string and matches the real response', async () => {
    const preview = await request(server)
      .post('/api/mock/preview')
      .set(dashboard())
      .send({ serviceSlug, method: 'GET', path: '/items?page=2' });
    const real = await request(server).get(`/mock/${serviceSlug}/items?page=2`).set(authed());
    expect(JSON.parse(preview.body.body)).toEqual(real.body);
  });

  it('3.17: the bare service URL gets a JSON answer, not the generic 404', async () => {
    const response = await request(server).get(`/mock/${serviceSlug}`).set(authed());
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('route_not_found');
  });

  it('3.13: a slug that slugifies to nothing is refused on update', async () => {
    await expect(updateService(org.orgId, serviceId, { slug: '!!!' })).rejects.toThrow(MockError);
  });

  it('3.10: the OpenAPI document needs a key with mock:read', async () => {
    const keysOnly = await createKey({
      orgId: org.orgId,
      name: 'keys-only',
      env: 'test',
      scopes: ['keys:read'],
      createdBy: org.userId,
    });

    const denied = await request(server)
      .get(`/docs/${serviceSlug}/openapi.json`)
      .set('Authorization', `Bearer ${keysOnly.key}`);
    expect(denied.status).toBe(403);

    const allowed = await request(server).get(`/docs/${serviceSlug}/openapi.json`).set(authed());
    expect(allowed.status).toBe(200);
    expect(Object.keys(allowed.body.paths)).toContain('/located/{id}');
  });
});
