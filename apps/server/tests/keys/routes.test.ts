import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { buildServer } from '../../src/index.js';
import { destroyTestOrg, type TestOrg } from './helpers.js';

/**
 * HTTP-level tests for the key routes.
 *
 * These exercise the real middleware chain: session auth, role permissions,
 * request validation, CSRF, and the one-time-reveal contract.
 */

let app: FastifyInstance;
let server: Server;

/**
 * Every account registered through the API, so the suite can clean up after
 * itself instead of leaving users and orgs behind in the database.
 */
const createdOrgs: TestOrg[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  // Supertest drives a Node http.Server; Fastify exposes one on `.server`.
  server = app.server;
});

afterAll(async () => {
  await app.close();
  for (const org of createdOrgs) {
    await destroyTestOrg(org);
  }
});

/**
 * A thin client that behaves like the browser: it keeps the session cookie
 * and echoes the readable CSRF cookie back in `X-CSRF-Token` on mutations.
 */
interface TestClient {
  /** The raw supertest agent, for tests that need to omit the CSRF header. */
  raw: ReturnType<typeof request.agent>;
  get(url: string): request.Test;
  post(url: string): request.Test;
}

async function signedInClient(label: string): Promise<TestClient> {
  const agent = request.agent(server);
  const email = `tb-routes-${label}-${Date.now()}@example.test`;

  const response = await agent
    .post('/api/auth/register')
    .send({ email, password: 'a-long-enough-password', name: 'Route Tester' });

  expect(response.status).toBe(201);

  // Register creates the user, a personal org, and an owner membership.
  createdOrgs.push({
    userId: response.body.user.id,
    orgId: response.body.org.id,
  });

  // The browser reads the CSRF token from document.cookie and echoes it back
  // in X-CSRF-Token. Read it from the Set-Cookie header the same way.
  const setCookie = response.headers['set-cookie'] as unknown as string[];
  const csrfCookie = setCookie?.find((c) => c.startsWith('throttlebox_csrf='));
  const csrfToken = csrfCookie?.split(';')[0]?.split('=')[1] ?? '';

  const csrf = () => ({ 'X-CSRF-Token': csrfToken });

  return {
    raw: agent,
    get: (url: string) => agent.get(url),
    post: (url: string) => agent.post(url).set(csrf()),
  };
}

describe('POST /api/keys', () => {
  it('requires a session', async () => {
    const response = await request(server).post('/api/keys').send({ name: 'nope' });
    expect(response.status).toBe(401);
  });

  it('rejects an invalid body', async () => {
    const client = await signedInClient('invalid');
    const response = await client.post('/api/keys').send({ name: '' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('validation_error');
  });

  it('creates a key and returns the raw key exactly once', async () => {
    const client = await signedInClient('create');

    const created = await client.post('/api/keys').send({ name: 'my-service', env: 'live' });

    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^sk_live_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}$/);
    expect(created.body.warning).toMatch(/only time/i);
    expect(created.body.scopes).toEqual(['mock:read']);

    // Listing never returns the secret again.
    const listed = await client.get('/api/keys');
    expect(listed.status).toBe(200);
    expect(listed.body.keys).toHaveLength(1);
    expect(listed.body.keys[0].display).toBe(`${created.body.prefix}…${created.body.last4}`);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.key);
  });

  it('rejects a repeated Idempotency-Key with a conflict', async () => {
    const client = await signedInClient('idempotent');

    const first = await client
      .post('/api/keys')
      .set('Idempotency-Key', 'fixed-token')
      .send({ name: 'once' });
    expect(first.status).toBe(201);

    const second = await client
      .post('/api/keys')
      .set('Idempotency-Key', 'fixed-token')
      .send({ name: 'once' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('duplicate_idempotency_key');
  });
});

describe('CSRF protection', () => {
  it('rejects a cookie-authenticated mutation with no CSRF token', async () => {
    const client = await signedInClient('csrf-missing');

    // The raw agent sends the session cookie but no X-CSRF-Token, which is
    // exactly what a cross-site page can do.
    const response = await client.raw.post('/api/keys').send({ name: 'forged' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('csrf_failed');
  });

  it('rejects a mutation with a mismatched CSRF token', async () => {
    const client = await signedInClient('csrf-wrong');

    const response = await client.raw
      .post('/api/keys')
      .set('X-CSRF-Token', 'a'.repeat(64))
      .send({ name: 'forged' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('csrf_failed');
  });

  it('allows a safe method without a CSRF token', async () => {
    const client = await signedInClient('csrf-safe');

    const response = await client.raw.get('/api/keys');
    expect(response.status).toBe(200);
  });
});

describe('GET /api/keys', () => {
  it('returns a list for a signed-in user', async () => {
    const client = await signedInClient('list');
    const response = await client.get('/api/keys');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.keys)).toBe(true);
  });

  it('returns 404 for an unknown id', async () => {
    const client = await signedInClient('missing');
    const response = await client.get('/api/keys/00000000-0000-0000-0000-000000000000');
    expect(response.status).toBe(404);
  });
});

describe('POST /api/keys/:id/rotate', () => {
  it('mints a new key and keeps the old one alive during the grace window', async () => {
    const client = await signedInClient('rotate');

    const created = await client.post('/api/keys').send({ name: 'rotating' });
    const rotated = await client
      .post(`/api/keys/${created.body.id}/rotate`)
      .send({ graceHours: 24 });

    expect(rotated.status).toBe(201);
    expect(rotated.body.key).not.toBe(created.body.key);
    expect(rotated.body.warning).toMatch(/only time/i);

    // The old key still shows as active in the list.
    const listed = await client.get('/api/keys');
    const old = listed.body.keys.find((k: { id: string }) => k.id === created.body.id);
    expect(old?.status).toBe('active');
    expect(old?.graceUntil).toBeTruthy();
  });

  it('returns 404 for an unknown id', async () => {
    const client = await signedInClient('rotate-missing');
    const response = await client
      .post('/api/keys/00000000-0000-0000-0000-000000000000/rotate')
      .send({});
    expect(response.status).toBe(404);
  });
});

describe('POST /api/keys/:id/revoke', () => {
  it('revokes a key', async () => {
    const client = await signedInClient('revoke');

    const created = await client.post('/api/keys').send({ name: 'to-revoke' });
    const revoked = await client.post(`/api/keys/${created.body.id}/revoke`).send({});

    expect(revoked.status).toBe(204);

    const listed = await client.get('/api/keys');
    const row = listed.body.keys.find((k: { id: string }) => k.id === created.body.id);
    expect(row?.status).toBe('revoked');
  });

  it('returns 409 when revoking an already-revoked key', async () => {
    const client = await signedInClient('revoke-twice');

    const created = await client.post('/api/keys').send({ name: 'twice' });
    await client.post(`/api/keys/${created.body.id}/revoke`).send({});
    const again = await client.post(`/api/keys/${created.body.id}/revoke`).send({});

    expect(again.status).toBe(409);
  });

  it('accepts a bodyless POST regardless of the content type the client sends', async () => {
    const client = await signedInClient('revoke-content-type');

    const created = await client.post('/api/keys').send({ name: 'content-types' });

    // Some clients (form-style libraries, PowerShell) set a content type even
    // when there is no body. That must not turn into a 415.
    const response = await client
      .post(`/api/keys/${created.body.id}/revoke`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('');

    expect(response.status).toBe(204);
  });

  it('still rejects a non-empty body sent with an unsupported content type', async () => {
    const client = await signedInClient('revoke-bad-body');

    const created = await client.post('/api/keys').send({ name: 'bad-body' });

    const response = await client
      .post(`/api/keys/${created.body.id}/revoke`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('not-empty');

    expect(response.status).toBe(415);
  });
});
