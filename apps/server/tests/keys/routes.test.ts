import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { buildServer } from '../../src/index.js';
import { createTestOrg, destroyTestOrg, type TestOrg } from './helpers.js';

/**
 * HTTP-level tests for the key routes.
 *
 * These exercise the real middleware chain: session auth, role permissions,
 * request validation, and the one-time-reveal contract.
 */

let app: FastifyInstance;
let server: Server;
let org: TestOrg;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  // Supertest drives a Node http.Server; Fastify exposes one on `.server`.
  server = app.server;
  org = await createTestOrg('routes');
});

afterAll(async () => {
  await app.close();
  await destroyTestOrg(org);
});

/** Register a fresh account and return an agent holding its session cookie. */
async function signedInAgent(label: string) {
  const agent = request.agent(server);
  const email = `tb-routes-${label}-${Date.now()}@example.test`;

  const response = await agent
    .post('/api/auth/register')
    .send({ email, password: 'a-long-enough-password', name: 'Route Tester' });

  expect(response.status).toBe(201);
  return agent;
}

describe('POST /api/keys', () => {
  it('requires a session', async () => {
    const response = await request(server).post('/api/keys').send({ name: 'nope' });
    expect(response.status).toBe(401);
  });

  it('rejects an invalid body', async () => {
    const agent = await signedInAgent('invalid');
    const response = await agent.post('/api/keys').send({ name: '' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('validation_error');
  });

  it('creates a key and returns the raw key exactly once', async () => {
    const agent = await signedInAgent('create');

    const created = await agent.post('/api/keys').send({ name: 'my-service', env: 'live' });

    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^sk_live_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}$/);
    expect(created.body.warning).toMatch(/only time/i);
    expect(created.body.scopes).toEqual(['mock:read']);

    // Listing never returns the secret again.
    const listed = await agent.get('/api/keys');
    expect(listed.status).toBe(200);
    expect(listed.body.keys).toHaveLength(1);
    expect(listed.body.keys[0].display).toBe(`${created.body.prefix}…${created.body.last4}`);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.key);
  });

  it('rejects a repeated Idempotency-Key with a conflict', async () => {
    const agent = await signedInAgent('idempotent');

    const first = await agent
      .post('/api/keys')
      .set('Idempotency-Key', 'fixed-token')
      .send({ name: 'once' });
    expect(first.status).toBe(201);

    const second = await agent
      .post('/api/keys')
      .set('Idempotency-Key', 'fixed-token')
      .send({ name: 'once' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('duplicate_idempotency_key');
  });
});

describe('GET /api/keys', () => {
  it('returns a list for a signed-in user', async () => {
    const agent = await signedInAgent('list');
    const response = await agent.get('/api/keys');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.keys)).toBe(true);
  });

  it('returns 404 for an unknown id', async () => {
    const agent = await signedInAgent('missing');
    const response = await agent.get('/api/keys/00000000-0000-0000-0000-000000000000');
    expect(response.status).toBe(404);
  });
});

describe('POST /api/keys/:id/rotate', () => {
  it('mints a new key and keeps the old one alive during the grace window', async () => {
    const agent = await signedInAgent('rotate');

    const created = await agent.post('/api/keys').send({ name: 'rotating' });
    const rotated = await agent
      .post(`/api/keys/${created.body.id}/rotate`)
      .send({ graceHours: 24 });

    expect(rotated.status).toBe(201);
    expect(rotated.body.key).not.toBe(created.body.key);
    expect(rotated.body.warning).toMatch(/only time/i);

    // The old key still shows as active in the list.
    const listed = await agent.get('/api/keys');
    const old = listed.body.keys.find((k: { id: string }) => k.id === created.body.id);
    expect(old?.status).toBe('active');
    expect(old?.graceUntil).toBeTruthy();
  });

  it('returns 404 for an unknown id', async () => {
    const agent = await signedInAgent('rotate-missing');
    const response = await agent
      .post('/api/keys/00000000-0000-0000-0000-000000000000/rotate')
      .send({});
    expect(response.status).toBe(404);
  });
});

describe('POST /api/keys/:id/revoke', () => {
  it('revokes a key', async () => {
    const agent = await signedInAgent('revoke');

    const created = await agent.post('/api/keys').send({ name: 'to-revoke' });
    const revoked = await agent.post(`/api/keys/${created.body.id}/revoke`).send({});

    expect(revoked.status).toBe(204);

    const listed = await agent.get('/api/keys');
    const row = listed.body.keys.find((k: { id: string }) => k.id === created.body.id);
    expect(row?.status).toBe('revoked');
  });

  it('returns 409 when revoking an already-revoked key', async () => {
    const agent = await signedInAgent('revoke-twice');

    const created = await agent.post('/api/keys').send({ name: 'twice' });
    await agent.post(`/api/keys/${created.body.id}/revoke`).send({});
    const again = await agent.post(`/api/keys/${created.body.id}/revoke`).send({});

    expect(again.status).toBe(409);
  });

  it('accepts a bodyless POST regardless of the content type the client sends', async () => {
    const agent = await signedInAgent('revoke-content-type');

    const created = await agent.post('/api/keys').send({ name: 'content-types' });

    // Some clients (form-style libraries, PowerShell) set a content type even
    // when there is no body. That must not turn into a 415.
    const response = await agent
      .post(`/api/keys/${created.body.id}/revoke`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('');

    expect(response.status).toBe(204);
  });

  it('still rejects a non-empty body sent with an unsupported content type', async () => {
    const agent = await signedInAgent('revoke-bad-body');

    const created = await agent.post('/api/keys').send({ name: 'bad-body' });

    const response = await agent
      .post(`/api/keys/${created.body.id}/revoke`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('not-empty');

    expect(response.status).toBe(415);
  });
});
