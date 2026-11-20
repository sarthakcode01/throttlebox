import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { playgroundRequests, playgroundSessions } from '../../src/db/schema.js';
import { purgeOldPlaygroundData } from '../../src/playground/store.js';
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
beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
  await runMemberCleanup();
});

async function setup(label: string) {
  const owner = await signUp(t, label);
  const key = await createApiKey(owner);
  const session = (await owner.post('/api/playground/sessions').send({ name: 'My session' })).body
    .session;
  return { owner, key, session };
}

function send(owner: Client, sessionId: string, body: Record<string, unknown>) {
  return owner.post(`/api/playground/sessions/${sessionId}/send`).send(body);
}

const GET_PRODUCT = (keyId: string) => ({
  keyId,
  method: 'GET',
  serviceSlug: 'ecommerce',
  path: '/products/42',
});

describe('sessions', () => {
  it('creates, lists (with request counts), renames and deletes', async () => {
    const { owner, key, session } = await setup('pg-sessions');
    expect(session.name).toBe('My session');
    expect(session.requestCount).toBe(0);

    await send(owner, session.id, GET_PRODUCT(key.id));
    const list = await owner.get('/api/playground/sessions');
    expect(list.status).toBe(200);
    expect(list.body.sessions.find((s: { id: string }) => s.id === session.id).requestCount).toBe(1);

    const renamed = await owner.patch(`/api/playground/sessions/${session.id}`).send({ name: 'Renamed' });
    expect(renamed.body.session.name).toBe('Renamed');
    expect(renamed.body.session.requestCount).toBe(1);

    expect((await owner.delete(`/api/playground/sessions/${session.id}`)).status).toBe(200);
    expect((await owner.get(`/api/playground/sessions/${session.id}/requests`)).status).toBe(404);
  });

  it('defaults the session name and rejects an empty rename', async () => {
    const owner = await signUp(t, 'pg-name');
    const created = await owner.post('/api/playground/sessions').send({});
    expect(created.status).toBe(201);
    expect(created.body.session.name).toBe('Untitled session');
    const bad = await owner.patch(`/api/playground/sessions/${created.body.session.id}`).send({ name: '  ' });
    expect(bad.status).toBe(400);
  });

  it('deleting a session removes its requests (cascade)', async () => {
    const { owner, key, session } = await setup('pg-cascade');
    const sent = await send(owner, session.id, GET_PRODUCT(key.id));
    await owner.delete(`/api/playground/sessions/${session.id}`);
    const rows = await db
      .select()
      .from(playgroundRequests)
      .where(eq(playgroundRequests.id, sent.body.request.id));
    expect(rows).toHaveLength(0);
  });
});

describe('send', () => {
  it('captures the full request and response', async () => {
    const { owner, key, session } = await setup('pg-send');
    const res = await send(owner, session.id, {
      ...GET_PRODUCT(key.id),
      query: { verbose: '1' },
      headers: { 'X-Trace': 'abc' },
    });
    expect(res.status).toBe(201);
    const r = res.body.request;
    expect(r.kind).toBe('send');
    expect(r.parentId).toBeNull();
    expect(r.method).toBe('GET');
    expect(r.path).toBe('/products/42');
    expect(r.query).toEqual({ verbose: '1' });
    expect(r.headers).toEqual({ 'x-trace': 'abc' });
    expect(r.outcome).toBe('ok');
    expect(r.responseStatus).toBe(200);
    expect(JSON.parse(r.responseBody).id).toBe('42');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.keyDisplay).toMatch(/^sk_test/);
    expect(r.responseHeaders['x-ratelimit-limit']).toBe('100');
  });

  it('never stores credentials: authorization, cookie, csrf and internal headers are dropped', async () => {
    const { owner, key, session } = await setup('pg-redact');
    const res = await send(owner, session.id, {
      ...GET_PRODUCT(key.id),
      headers: {
        Authorization: `Bearer ${key.key}`,
        Cookie: 'throttlebox_session=abc',
        'X-CSRF-Token': 'zzz',
        'X-Throttlebox-Internal': 'spoofed',
        'X-Ok': 'yes',
      },
    });
    expect(res.body.request.headers).toEqual({ 'x-ok': 'yes' });
    const stored = JSON.stringify(
      (await owner.get(`/api/playground/requests/${res.body.request.id}`)).body,
    );
    expect(stored).not.toContain(key.key);
    expect(stored).not.toContain('throttlebox_session');
  });

  it('redacts a raw API key echoed in the request body', async () => {
    const { owner, key, session } = await setup('pg-bodyredact');
    const svc = await owner.post('/api/mock/services').send({ name: 'Echo', slug: 'echo' });
    await owner.post(`/api/mock/services/${svc.body.service.id}/routes`).send({
      method: 'POST',
      path: '/e',
      responseTemplate: { ok: true },
    });
    const res = await send(owner, session.id, {
      keyId: key.id,
      method: 'POST',
      serviceSlug: 'echo',
      path: '/e',
      body: JSON.stringify({ token: key.key }),
    });
    expect(res.body.request.body).not.toContain(key.key);
    expect(res.body.request.body).toContain('sk_***');
  });

  it('records a chaos-dropped request with a null status', async () => {
    const { owner, key, session } = await setup('pg-dropped');
    await owner.put('/api/chaos').send({
      isEnabled: true,
      latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
      errors: { enabled: false, rate5xx: 0, rate429: 0, statusCodes: [500] },
      partition: { enabled: true, dropRate: 1 },
    });
    const res = await send(owner, session.id, GET_PRODUCT(key.id));
    expect(res.status).toBe(201);
    expect(res.body.request.outcome).toBe('dropped');
    expect(res.body.request.responseStatus).toBeNull();
  });

  it.each([
    ['a path without a leading slash', { path: 'products' }],
    ['a query string smuggled in the path', { path: '/products?x=1' }],
    ['a fragment in the path', { path: '/products#frag' }],
    ['a dot-dot segment', { path: '/../../api/me' }],
    ['a backslash', { path: '/a\\b' }],
    ['an unknown method', { method: 'TRACE' }],
    ['a non-uuid key', { keyId: 'nope' }],
    ['a service slug with a slash', { serviceSlug: 'a/b' }],
  ])('rejects %s with 400', async (_label, override) => {
    const { owner, key, session } = await setup('pg-validate');
    const res = await send(owner, session.id, { ...GET_PRODUCT(key.id), ...override });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('cannot be used to reach anything outside /mock: the target is always /mock/<slug>/...', async () => {
    const { owner, key, session } = await setup('pg-ssrf');
    const res = await send(owner, session.id, {
      ...GET_PRODUCT(key.id),
      serviceSlug: 'ecommerce',
      path: '/..%2f..%2fapi/me',
    });
    // Whatever the router decides, it is a mock 404 — never the dashboard API.
    expect(res.status).toBe(201);
    expect(res.body.request.responseStatus).toBe(404);
    expect(JSON.parse(res.body.request.responseBody).error).toMatch(/route_not_found|service_not_found/);
  });

  it('404s for a session that does not exist', async () => {
    const { owner, key } = await setup('pg-nosession');
    const res = await send(owner, '00000000-0000-4000-8000-000000000000', GET_PRODUCT(key.id));
    expect(res.status).toBe(404);
  });

  it('enforces the per-session request cap before executing', async () => {
    const { owner, key, session } = await setup('pg-cap');
    const rows = Array.from({ length: 500 }, (_, i) => ({
      sessionId: session.id,
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET' as const,
      serviceSlug: 'ecommerce',
      path: `/products/${i}`,
    }));
    await db.insert(playgroundRequests).values(rows);
    const res = await send(owner, session.id, GET_PRODUCT(key.id));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('limit_reached');
  });
});

describe('history, replay and fork', () => {
  it('lists newest first and paginates with a cursor', async () => {
    const { owner, key, session } = await setup('pg-history');
    for (let i = 1; i <= 3; i++) {
      await send(owner, session.id, { ...GET_PRODUCT(key.id), path: `/products/${i}` });
      await new Promise((r) => setTimeout(r, 5));
    }
    const first = await owner.get(`/api/playground/sessions/${session.id}/requests?limit=2`);
    expect(first.body.requests.map((r: { path: string }) => r.path)).toEqual(['/products/3', '/products/2']);
    const cursor = first.body.requests[1].createdAt;
    const next = await owner.get(
      `/api/playground/sessions/${session.id}/requests?limit=2&before=${encodeURIComponent(cursor)}`,
    );
    expect(next.body.requests.map((r: { path: string }) => r.path)).toEqual(['/products/1']);
  });

  it('replay re-runs verbatim and links back to the original', async () => {
    const { owner, key, session } = await setup('pg-replay');
    const original = (
      await send(owner, session.id, { ...GET_PRODUCT(key.id), query: { a: '1' }, headers: { 'x-k': 'v' } })
    ).body.request;

    const replay = await owner.post(`/api/playground/requests/${original.id}/replay`).send({});
    expect(replay.status).toBe(201);
    const r = replay.body.request;
    expect(r.kind).toBe('replay');
    expect(r.parentId).toBe(original.id);
    expect(r.sessionId).toBe(session.id);
    expect(r.method).toBe(original.method);
    expect(r.path).toBe(original.path);
    expect(r.query).toEqual(original.query);
    expect(r.headers).toEqual(original.headers);
    // Deterministic mock data: an unchanged replay returns the same body.
    expect(r.responseBody).toBe(original.responseBody);
  });

  it('replay can switch to a different key, and refuses one from another org', async () => {
    const { owner, key, session } = await setup('pg-replaykey');
    const key2 = await createApiKey(owner);
    const original = (await send(owner, session.id, GET_PRODUCT(key.id))).body.request;

    const ok = await owner.post(`/api/playground/requests/${original.id}/replay`).send({ keyId: key2.id });
    expect(ok.body.request.keyId).toBe(key2.id);

    const other = await signUp(t, 'pg-otherorg');
    const foreignKey = await createApiKey(other);
    const bad = await owner.post(`/api/playground/requests/${original.id}/replay`).send({ keyId: foreignKey.id });
    expect(bad.status).toBe(404);
  });

  it('replay surfaces a clear error when the original key was deleted', async () => {
    const { owner, key, session } = await setup('pg-nokey');
    const original = (await send(owner, session.id, GET_PRODUCT(key.id))).body.request;
    await db.update(playgroundRequests).set({ keyId: null }).where(eq(playgroundRequests.id, original.id));
    const res = await owner.post(`/api/playground/requests/${original.id}/replay`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('key_required');
  });

  it('fork records kind=fork with the parent', async () => {
    const { owner, key, session } = await setup('pg-fork');
    const original = (await send(owner, session.id, GET_PRODUCT(key.id))).body.request;
    const forked = await send(owner, session.id, {
      ...GET_PRODUCT(key.id),
      path: '/products/99',
      parentId: original.id,
    });
    expect(forked.body.request.kind).toBe('fork');
    expect(forked.body.request.parentId).toBe(original.id);
  });

  it('a replay that hits chaos differs from the original (the time-travel loop)', async () => {
    const { owner, key, session } = await setup('pg-loop');
    const clean = (await send(owner, session.id, GET_PRODUCT(key.id))).body.request;
    await owner.put('/api/chaos').send({
      isEnabled: true,
      latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
      errors: { enabled: true, rate5xx: 1, rate429: 0, statusCodes: [503] },
      partition: { enabled: false, dropRate: 0 },
    });
    const faulty = (await owner.post(`/api/playground/requests/${clean.id}/replay`).send({})).body.request;
    expect(clean.responseStatus).toBe(200);
    expect(faulty.responseStatus).toBe(503);
    expect(faulty.responseHeaders['x-throttlebox-chaos-injected']).toBe('true');
    expect(faulty.parentId).toBe(clean.id);
  });
});

describe('tenant isolation and permissions', () => {
  it('another organization gets 404 for sessions, requests, replay, fork parent and export', async () => {
    const { owner, key, session } = await setup('pg-iso-a');
    const original = (await send(owner, session.id, GET_PRODUCT(key.id))).body.request;

    const intruder = await signUp(t, 'pg-iso-b');
    const intruderKey = await createApiKey(intruder);
    const mine = (await intruder.post('/api/playground/sessions').send({})).body.session;

    expect((await intruder.get(`/api/playground/sessions/${session.id}/requests`)).status).toBe(404);
    expect((await intruder.get(`/api/playground/requests/${original.id}`)).status).toBe(404);
    expect((await intruder.post(`/api/playground/requests/${original.id}/replay`).send({})).status).toBe(404);
    expect((await intruder.patch(`/api/playground/sessions/${session.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await intruder.delete(`/api/playground/sessions/${session.id}`)).status).toBe(404);
    expect((await intruder.get(`/api/playground/sessions/${session.id}/export`)).status).toBe(404);
    expect((await send(intruder, session.id, GET_PRODUCT(intruderKey.id))).status).toBe(404);
    expect(
      (await send(intruder, mine.id, { ...GET_PRODUCT(intruderKey.id), parentId: original.id })).status,
    ).toBe(404);
    // And my own key id cannot be used from their org.
    expect((await send(intruder, mine.id, GET_PRODUCT(key.id))).status).toBe(404);

    const listed = await intruder.get('/api/playground/sessions');
    expect(listed.body.sessions.map((s: { id: string }) => s.id)).not.toContain(session.id);
  });

  it('requires authentication', async () => {
    expect((await request(t.server).get('/api/playground/sessions')).status).toBe(401);
  });

  it('viewers can read and export but cannot send, replay or manage sessions', async () => {
    const { owner, key, session } = await setup('pg-rbac');
    const original = (await send(owner, session.id, GET_PRODUCT(key.id))).body.request;
    const viewer = await signInAsMember(t, owner.orgId, 'viewer');
    const dev = await signInAsMember(t, owner.orgId, 'dev');

    expect((await viewer.get('/api/playground/sessions')).status).toBe(200);
    expect((await viewer.get(`/api/playground/sessions/${session.id}/requests`)).status).toBe(200);
    expect((await viewer.get(`/api/playground/sessions/${session.id}/export`)).status).toBe(200);

    expect((await send(viewer, session.id, GET_PRODUCT(key.id))).status).toBe(403);
    expect((await viewer.post(`/api/playground/requests/${original.id}/replay`).send({})).status).toBe(403);
    expect((await viewer.post('/api/playground/sessions').send({})).status).toBe(403);
    expect((await viewer.delete(`/api/playground/sessions/${session.id}`)).status).toBe(403);

    expect((await send(dev, session.id, GET_PRODUCT(key.id))).status).toBe(201);
  });

  it('is CSRF-protected like every other session-authenticated mutation', async () => {
    const { owner, key, session } = await setup('pg-csrf');
    const agent = request.agent(t.server);
    await agent.post('/api/auth/login').send({ email: owner.email, password: 'a-long-enough-password' });
    const res = await agent.post(`/api/playground/sessions/${session.id}/send`).send(GET_PRODUCT(key.id));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_failed');
  });
});

describe('retention', () => {
  it('purges requests older than the window and the sessions they leave empty', async () => {
    const { owner, key, session } = await setup('pg-retention');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await db.insert(playgroundRequests).values({
      sessionId: session.id,
      orgId: owner.orgId,
      keyId: key.id,
      method: 'GET',
      serviceSlug: 'ecommerce',
      path: '/old',
      createdAt: old,
    });
    await db.update(playgroundSessions).set({ updatedAt: old }).where(eq(playgroundSessions.id, session.id));
    const fresh = (await owner.post('/api/playground/sessions').send({})).body.session;
    await send(owner, fresh.id, GET_PRODUCT(key.id));

    const removed = await purgeOldPlaygroundData(30);
    expect(removed).toBeGreaterThanOrEqual(1);

    const sessions = (await owner.get('/api/playground/sessions')).body.sessions.map((s: { id: string }) => s.id);
    expect(sessions).not.toContain(session.id);
    expect(sessions).toContain(fresh.id);
  });
});
