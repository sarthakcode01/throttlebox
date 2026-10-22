import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { buildServer } from '../../src/index.js';
import { createSession, SESSION_COOKIE, CSRF_COOKIE } from '../../src/auth/session.js';
import { createRoute, createService, invalidateRouterCache } from '../../src/mock/services.js';
import { createTestOrg, destroyTestOrg, type TestOrg } from '../keys/helpers.js';

/**
 * The services and routes CRUD API, driven over HTTP with a session.
 */
describe('services CRUD', () => {
  let app: FastifyInstance;
  let server: Server;
  let org: TestOrg;
  let serviceId: string;
  let client: Awaited<ReturnType<typeof makeClient>>;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    server = app.server;
    org = await createTestOrg('crud');

    const service = await createService(org.orgId, { name: 'CRUD Service' });
    serviceId = service.id;
    invalidateRouterCache();

    client = await makeClient(server, org.userId);
  });

  afterAll(async () => {
    await app.close();
    invalidateRouterCache();
    await destroyTestOrg(org);
  });

  it('lists the services of the org', async () => {
    const response = await client.get('/api/mock/services');
    expect(response.status).toBe(200);
    expect(response.body.services.some((s: { id: string }) => s.id === serviceId)).toBe(true);
  });

  it('creates a service and a route', async () => {
    const service = await client
      .post('/api/mock/services')
      .send({ name: 'Weather API', description: 'Forecasts' });
    expect(service.status).toBe(201);
    expect(service.body.service.slug).toBe('weather-api');

    const route = await client.post(`/api/mock/services/${service.body.service.id}/routes`).send({
      method: 'GET',
      path: '/forecast/:city',
      statusCode: 200,
      responseTemplate: { city: '{{params.city}}' },
    });

    expect(route.status).toBe(201);
    expect(route.body.route.path).toBe('/forecast/:city');
  });

  it('rejects a duplicate route with a 409', async () => {
    await createRoute(org.orgId, serviceId, {
      method: 'GET',
      path: '/dupe',
      statusCode: 200,
      responseTemplate: {},
    });

    const response = await client
      .post(`/api/mock/services/${serviceId}/routes`)
      .send({ method: 'GET', path: '/dupe' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('duplicate');
  });

  it('rejects a duplicate route created by an update with a 409', async () => {
    await createRoute(org.orgId, serviceId, {
      method: 'GET',
      path: '/keep',
      statusCode: 200,
      responseTemplate: {},
    });
    await createRoute(org.orgId, serviceId, {
      method: 'GET',
      path: '/target',
      statusCode: 200,
      responseTemplate: {},
    });

    const list = await client.get(`/api/mock/services/${serviceId}/routes`);
    const target = list.body.routes.find((r: { path: string }) => r.path === '/target');

    const response = await client.patch(`/api/mock/routes/${target.id}`).send({ path: '/keep' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('duplicate');
  });

  it('does not leak the database error when something unexpected fails', async () => {
    // A malformed id is a client error, not a server error.
    const bad = await client.get('/api/mock/services/not-a-uuid/routes');
    expect(bad.status).toBe(400);

    // And an internal failure must not carry the raw constraint name.
    const response = await client.patch('/api/mock/routes/not-a-uuid').send({ path: '/x' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('mock_routes_');
  });

  it('deletes a service that is not seeded', async () => {
    const disposable = await createService(org.orgId, { name: 'Disposable One' });
    const services = await client.get('/api/mock/services');
    const found = services.body.services.find((s: { id: string }) => s.id === disposable.id);

    const response = await client.delete(`/api/mock/services/${found.id}`);
    expect(response.status).toBe(204);
  });
});

/**
 * A tiny client that carries the session and CSRF token on every request,
 * the way a browser would.
 */
async function makeClient(server: Server, userId: string) {
  const agent = request.agent(server);
  const session = await createSession({ userId });
  const headers = {
    Cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrfToken}`,
    'X-CSRF-Token': session.csrfToken,
  };

  return {
    get: (url: string) => agent.get(url).set(headers),
    post: (url: string) => agent.post(url).set(headers),
    patch: (url: string) => agent.patch(url).set(headers),
    delete: (url: string) => agent.delete(url).set(headers),
  };
}
