import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { buildServer } from '../../src/index.js';
import { destroyTestOrg, type TestOrg } from '../keys/helpers.js';

let app: FastifyInstance;
let server: Server;
const createdOrgs: TestOrg[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  server = app.server;
});

afterAll(async () => {
  await app.close();
  for (const org of createdOrgs) {
    await destroyTestOrg(org);
  }
});

interface TestClient {
  get(url: string): request.Test;
  post(url: string): request.Test;
  delete(url: string): request.Test;
}

async function signedInClient(label: string): Promise<TestClient> {
  const agent = request.agent(server);
  const email = `tb-analytics-${label}-${Date.now()}@example.test`;

  const response = await agent
    .post('/api/auth/register')
    .send({ email, password: 'a-long-enough-password', name: 'Analytics Tester' });

  expect(response.status).toBe(201);

  createdOrgs.push({
    userId: response.body.user.id,
    orgId: response.body.org.id,
  });

  const setCookie = response.headers['set-cookie'] as unknown as string[];
  const csrfCookie = setCookie?.find((c) => c.startsWith('throttlebox_csrf='));
  const csrfToken = csrfCookie?.split(';')[0]?.split('=')[1] ?? '';

  const csrf = () => ({ 'X-CSRF-Token': csrfToken });

  return {
    get: (url: string) => agent.get(url),
    post: (url: string) => agent.post(url).set(csrf()),
    delete: (url: string) => agent.delete(url).set(csrf()),
  };
}

describe('Analytics API routes', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(server).get('/api/analytics/overview');
    expect(res.status).toBe(401);
  });

  it('retrieves overview, usage, latency, errors and logs for authenticated organization', async () => {
    const client = await signedInClient('routes-read');

    // 1. Overview
    const overviewRes = await client.get('/api/analytics/overview?range=24h');
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body).toHaveProperty('totalRequests');
    expect(overviewRes.body).toHaveProperty('errorRate');
    expect(overviewRes.body).toHaveProperty('p95LatencyMs');
    expect(overviewRes.body).toHaveProperty('throttledRequests');
    expect(overviewRes.body).toHaveProperty('activeKeysCount');

    // 2. Usage
    const usageRes = await client.get('/api/analytics/usage?range=24h');
    expect(usageRes.status).toBe(200);
    expect(usageRes.body).toHaveProperty('series');
    expect(Array.isArray(usageRes.body.series)).toBe(true);

    // 3. Latency
    const latencyRes = await client.get('/api/analytics/latency?range=24h');
    expect(latencyRes.status).toBe(200);
    expect(latencyRes.body).toHaveProperty('series');
    expect(Array.isArray(latencyRes.body.series)).toBe(true);

    // 4. Errors
    const errorsRes = await client.get('/api/analytics/errors?range=24h');
    expect(errorsRes.status).toBe(200);
    expect(errorsRes.body).toHaveProperty('status2xx');
    expect(errorsRes.body).toHaveProperty('status4xx');
    expect(errorsRes.body).toHaveProperty('status429');
    expect(errorsRes.body).toHaveProperty('status5xx');
    expect(Array.isArray(errorsRes.body.topErrorPaths)).toBe(true);

    // 5. Logs
    const logsRes = await client.get('/api/analytics/logs?limit=10&offset=0');
    expect(logsRes.status).toBe(200);
    expect(logsRes.body).toHaveProperty('logs');
    expect(logsRes.body).toHaveProperty('total');
    expect(Array.isArray(logsRes.body.logs)).toBe(true);
  });

  it('creates, lists, tests and deletes webhooks', async () => {
    const client = await signedInClient('routes-webhooks');

    // Create webhook
    const createRes = await client
      .post('/api/analytics/webhooks')
      .send({ url: 'https://example.com/alerts/quota' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.url).toBe('https://example.com/alerts/quota');
    expect(createRes.body.secret).toMatch(/^whsec_/);
    const webhookId = createRes.body.id;

    // List webhooks
    const listRes = await client.get('/api/analytics/webhooks');
    expect(listRes.status).toBe(200);
    expect(listRes.body.webhooks).toHaveLength(1);
    expect(listRes.body.webhooks[0].id).toBe(webhookId);

    // Reject SSRF attempts
    const ssrfRes = await client
      .post('/api/analytics/webhooks')
      .send({ url: 'http://169.254.169.254/metadata' });
    expect(ssrfRes.status).toBe(400);
    expect(ssrfRes.body.error).toBe('invalid_webhook_url');

    // Delete webhook
    const delRes = await client.delete(`/api/analytics/webhooks/${webhookId}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    // Confirm deleted
    const verifyRes = await client.get('/api/analytics/webhooks');
    expect(verifyRes.body.webhooks).toHaveLength(0);
  });
});
