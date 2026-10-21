import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { buildServer } from '../../src/index.js';
import { buildServiceRouter, normalizePath } from '../../src/mock/router.js';
import { buildOpenApiDocument, pathParameters } from '../../src/mock/openapi.js';
import { createKey } from '../../src/keys/store.js';
import { createService, createRoute } from '../../src/mock/services.js';
import { invalidateRouterCache } from '../../src/mock/services.js';
import { createTestOrg, destroyTestOrg, type TestOrg } from '../keys/helpers.js';

describe('router', () => {
  it('normalises paths', () => {
    expect(normalizePath('products')).toBe('/products');
    expect(normalizePath('/products/')).toBe('/products');
    expect(normalizePath('/products/:id')).toBe('/products/:id');
    expect(normalizePath('/')).toBe('/');
  });

  it('matches a static path', () => {
    const router = buildServiceRouter('svc', [
      {
        id: '1',
        method: 'GET',
        path: '/products',
        statusCode: 200,
        responseTemplate: {},
        responseHeaders: {},
        latencyMs: 0,
      },
    ]);

    expect(router.match('GET', '/products')?.route.id).toBe('1');
    expect(router.match('GET', '/products/')).not.toBeNull();
    expect(router.match('GET', '/other')).toBeNull();
    expect(router.match('POST', '/products')).toBeNull();
  });

  it('extracts path parameters', () => {
    const router = buildServiceRouter('svc', [
      {
        id: '1',
        method: 'GET',
        path: '/products/:id/reviews/:reviewId',
        statusCode: 200,
        responseTemplate: {},
        responseHeaders: {},
        latencyMs: 0,
      },
    ]);

    const match = router.match('GET', '/products/42/reviews/7');
    expect(match?.route.id).toBe('1');
    expect(match?.params).toEqual({ id: '42', reviewId: '7' });
  });

  it('prefers a static route over a parameterised one', () => {
    const router = buildServiceRouter('svc', [
      {
        id: 'param',
        method: 'GET',
        path: '/products/:id',
        statusCode: 200,
        responseTemplate: {},
        responseHeaders: {},
        latencyMs: 0,
      },
      {
        id: 'static',
        method: 'GET',
        path: '/products/featured',
        statusCode: 200,
        responseTemplate: {},
        responseHeaders: {},
        latencyMs: 0,
      },
    ]);

    expect(router.match('GET', '/products/featured')?.route.id).toBe('static');
    expect(router.match('GET', '/products/42')?.route.id).toBe('param');
  });
});

describe('openapi generation', () => {
  it('extracts path parameters', () => {
    expect(pathParameters('/products/:id')).toEqual(['id']);
    expect(pathParameters('/products/:id/reviews/:reviewId')).toEqual(['id', 'reviewId']);
    expect(pathParameters('/products')).toEqual([]);
  });

  it('builds a document with paths and parameters', () => {
    const document = buildOpenApiDocument({
      serviceName: 'E-commerce',
      serviceSlug: 'ecommerce',
      baseUrl: 'http://localhost:3001',
      routes: [
        {
          id: '1',
          method: 'GET',
          path: '/products/:id',
          statusCode: 200,
          responseTemplate: {},
          responseHeaders: { 'X-Total-Count': '42' },
          latencyMs: 0,
        },
      ],
    });

    expect(document.openapi).toBe('3.1.0');
    expect(document.servers[0]?.url).toBe('http://localhost:3001/mock/ecommerce');
    expect(Object.keys(document.paths)).toEqual(['/products/:id']);

    const operation = document.paths['/products/:id']?.get as {
      parameters: { name: string; in: string }[];
    };
    expect(operation.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
  });
});

describe('mock endpoint', () => {
  let app: FastifyInstance;
  let server: Server;
  let org: TestOrg;
  let readKey: string;
  let writeKey: string;
  let readOnlyKey: string;
  let serviceId: string;
  let serviceSlug: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    server = app.server;
    org = await createTestOrg('mock');

    const service = await createService(org.orgId, { name: 'Test Service' });
    serviceId = service.id;
    serviceSlug = service.slug;

    await createRoute(org.orgId, serviceId, {
      method: 'GET',
      path: '/items/:id',
      statusCode: 200,
      responseTemplate: { id: '{{params.id}}', page: '{{query.page "1"}}' },
    });
    await createRoute(org.orgId, serviceId, {
      method: 'POST',
      path: '/items',
      statusCode: 201,
      responseTemplate: { created: true, name: '{{body.name}}' },
    });

    const full = await createKey({
      orgId: org.orgId,
      name: 'full',
      env: 'test',
      scopes: ['mock:read', 'mock:write'],
      createdBy: org.userId,
    });
    readKey = full.key;

    const reader = await createKey({
      orgId: org.orgId,
      name: 'reader',
      env: 'test',
      scopes: ['mock:read'],
      createdBy: org.userId,
    });
    readOnlyKey = reader.key;

    const writer = await createKey({
      orgId: org.orgId,
      name: 'writer',
      env: 'test',
      scopes: ['mock:write'],
      createdBy: org.userId,
    });
    writeKey = writer.key;

    invalidateRouterCache();
  });

  afterAll(async () => {
    await app.close();
    invalidateRouterCache();
    await destroyTestOrg(org);
  });

  it('requires an API key', async () => {
    const response = await request(server).get(`/mock/${serviceSlug}/items/1`);
    expect(response.status).toBe(401);
  });

  it('rejects a key that does not exist', async () => {
    const response = await request(server)
      .get(`/mock/${serviceSlug}/items/1`)
      .set('Authorization', 'Bearer sk_test_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(response.status).toBe(401);
  });

  it('renders a templated response', async () => {
    const response = await request(server)
      .get(`/mock/${serviceSlug}/items/42?page=7`)
      .set('Authorization', `Bearer ${readKey}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: '42', page: '7' });
  });

  it('uses the default when a query parameter is absent', async () => {
    const response = await request(server)
      .get(`/mock/${serviceSlug}/items/42`)
      .set('Authorization', `Bearer ${readKey}`);

    expect(response.body).toEqual({ id: '42', page: '1' });
  });

  it('returns the configured status code', async () => {
    const response = await request(server)
      .post(`/mock/${serviceSlug}/items`)
      .set('Authorization', `Bearer ${writeKey}`)
      .send({ name: 'Widget' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ created: true, name: 'Widget' });
  });

  it('rejects a write with a read-only key', async () => {
    const response = await request(server)
      .post(`/mock/${serviceSlug}/items`)
      .set('Authorization', `Bearer ${readOnlyKey}`)
      .send({ name: 'Widget' });

    expect(response.status).toBe(403);
  });

  it('rejects a read with a write-only key', async () => {
    const response = await request(server)
      .get(`/mock/${serviceSlug}/items/1`)
      .set('Authorization', `Bearer ${writeKey}`);

    expect(response.status).toBe(403);
  });

  it('returns 404 for an unknown service', async () => {
    const response = await request(server)
      .get('/mock/nope/items/1')
      .set('Authorization', `Bearer ${readKey}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('service_not_found');
  });

  it('returns 404 with the available routes for an unknown path', async () => {
    const response = await request(server)
      .get(`/mock/${serviceSlug}/nope`)
      .set('Authorization', `Bearer ${readKey}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('route_not_found');
    expect(response.body.availableRoutes).toContain('GET /items/:id');
  });

  it("does not leak one org's services to another", async () => {
    const other = await createTestOrg('mock-other');
    try {
      const otherKey = await createKey({
        orgId: other.orgId,
        name: 'other',
        env: 'test',
        scopes: ['mock:read'],
        createdBy: other.userId,
      });

      const response = await request(server)
        .get(`/mock/${serviceSlug}/items/1`)
        .set('Authorization', `Bearer ${otherKey.key}`);

      expect(response.status).toBe(404);
    } finally {
      await destroyTestOrg(other);
    }
  });

  it('returns the same data for the same resource', async () => {
    const first = await request(server)
      .get(`/mock/${serviceSlug}/items/42`)
      .set('Authorization', `Bearer ${readKey}`);
    const second = await request(server)
      .get(`/mock/${serviceSlug}/items/42`)
      .set('Authorization', `Bearer ${readKey}`);

    expect(first.body).toEqual(second.body);
  });
});
