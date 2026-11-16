import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { buildServer } from '../../src/index.js';
import { db } from '../../src/db/client.js';
import { redis } from '../../src/db/redis.js';
import { chaosRules, orgWebhooks, requestLogs } from '../../src/db/schema.js';
import { createKey } from '../../src/keys/store.js';
import { createRoute, createService, invalidateRouterCache } from '../../src/mock/services.js';
import { createSession, CSRF_COOKIE, SESSION_COOKIE } from '../../src/auth/session.js';
import {
  flushAll,
  flushQueue,
  getQueueStats,
  recordRequestLog,
  resetQueueForTesting,
} from '../../src/analytics/ingest.js';
import { checkSingleOrgQuota } from '../../src/analytics/quotaMonitor.js';
import { isValidWebhookUrl, webhookTransport } from '../../src/analytics/webhooks.js';
import { BlockedAddressError, isBlockedAddress, safeLookup } from '../../src/http/ssrf.js';
import { shouldInjectError } from '../../src/chaos/sampling.js';
import { invalidateChaosRule } from '../../src/chaos/cache.js';
import { createTestOrg, destroyTestOrg, type TestOrg } from '../keys/helpers.js';

/**
 * Regression tests for the Phase 4, 5 and 6 fixes in
 * PHASE_WISE_BUG_REPORT.md and SECURITY_AUDIT_2026_11_16.md.
 */

describe('SSRF guard (C1, C3, 5.12)', () => {
  it('blocks the addresses the old filter let through', () => {
    for (const url of [
      'http://[fd12:3456::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[64:ff9b::7f00:1]/',
      'http://[::]/',
      'http://[fec0::1]/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://127.1/',
      'http://intranet/',
      'http://user:pass@example.com/',
    ]) {
      expect(isValidWebhookUrl(url).valid, url).toBe(false);
    }
    expect(isValidWebhookUrl('https://hooks.example.com/x').valid).toBe(true);
  });

  it('classifies literal addresses', () => {
    expect(isBlockedAddress('10.1.2.3')).toBe(true);
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('refuses at connect time a name that resolves to a private address', async () => {
    const lookup = promisify(safeLookup as never) as (h: string, o: object) => Promise<unknown>;
    await expect(lookup('localhost', {})).rejects.toBeInstanceOf(BlockedAddressError);
  });
});

describe('ingestion queue (5.2–5.5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetQueueForTesting();
  });

  it('5.2: one bad row is dropped and the rest of the batch is written', async () => {
    const orgId = randomUUID();
    const good = randomUUID();
    recordRequestLog({
      orgId,
      method: 'GET',
      path: '/a',
      statusCode: 200,
      latencyMs: 1,
      traceId: good,
    });
    recordRequestLog({
      orgId,
      method: 'GET',
      path: '/b',
      statusCode: Number.NaN,
      latencyMs: 1,
      traceId: randomUUID(),
    });

    await flushQueue();

    expect(getQueueStats().queueLength).toBe(0);
    const rows = await db.select().from(requestLogs).where(eq(requestLogs.traceId, good));
    expect(rows).toHaveLength(1);
    await db.delete(requestLogs).where(eq(requestLogs.orgId, orgId));
  });

  it('5.2: a row for a deleted service is accepted (no foreign keys on the hypertable)', async () => {
    const orgId = randomUUID();
    recordRequestLog({
      orgId,
      serviceId: randomUUID(),
      keyId: randomUUID(),
      method: 'GET',
      path: '/gone',
      statusCode: 200,
      latencyMs: 1,
      traceId: randomUUID(),
    });
    await flushQueue();
    const rows = await db.select().from(requestLogs).where(eq(requestLogs.orgId, orgId));
    expect(rows).toHaveLength(1);
    await db.delete(requestLogs).where(eq(requestLogs.orgId, orgId));
  });

  it('5.3: flushAll gives up at its deadline instead of spinning', async () => {
    vi.spyOn(db, 'insert').mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error('database down')),
    } as unknown as ReturnType<typeof db.insert>);

    recordRequestLog({
      orgId: randomUUID(),
      method: 'GET',
      path: '/x',
      statusCode: 200,
      latencyMs: 1,
      traceId: randomUUID(),
    });

    const started = Date.now();
    await flushAll(600);
    expect(Date.now() - started).toBeLessThan(3000);
    // The row is still queued for a later attempt, not lost.
    expect(getQueueStats().queueLength).toBe(1);
  });

  it('5.3: flushAll waits for a flush that is already running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(db, 'insert').mockReturnValue({
      values: vi.fn().mockImplementation(() => gate),
    } as unknown as ReturnType<typeof db.insert>);

    recordRequestLog({
      orgId: randomUUID(),
      method: 'GET',
      path: '/x',
      statusCode: 200,
      latencyMs: 1,
      traceId: randomUUID(),
    });
    void flushQueue(); // a timer flush, in progress

    const done = flushAll(5000);
    setTimeout(release, 50);
    await done;
    expect(getQueueStats().queueLength).toBe(0);
  });
});

describe('analytics and chaos over HTTP', () => {
  let app: FastifyInstance;
  let server: Server;
  let org: TestOrg;
  let other: TestOrg;
  let key: string;
  let otherKeyId: string;
  let session: { token: string; csrfToken: string };
  const slug = `regan-${Date.now().toString(36)}`;

  const dashboard = () => ({
    Cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrfToken}`,
    'X-CSRF-Token': session.csrfToken,
  });

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    server = app.server;
    org = await createTestOrg('reg-analytics');
    other = await createTestOrg('reg-analytics-other');

    const service = await createService(org.orgId, { name: 'Analytics', slug });
    await createRoute(org.orgId, service.id, { method: 'GET', path: '/ok', responseTemplate: {} });
    key = (await createKey({ orgId: org.orgId, name: 'a', env: 'test', createdBy: org.userId }))
      .key;
    otherKeyId = (
      await createKey({ orgId: other.orgId, name: 'b', env: 'test', createdBy: other.userId })
    ).id;
    session = await createSession({ userId: org.userId });
    invalidateRouterCache();
  });

  afterAll(async () => {
    await app.close();
    await db.delete(requestLogs).where(eq(requestLogs.orgId, org.orgId));
    await destroyTestOrg(org);
    await destroyTestOrg(other);
  });

  it('5.8 / 5.9: bad analytics parameters are a 400, not a 500', async () => {
    const limit = await request(server).get('/api/analytics/logs?limit=abc').set(dashboard());
    expect(limit.status).toBe(400);

    const keyId = await request(server).get('/api/analytics/usage?keyId=nope').set(dashboard());
    expect(keyId.status).toBe(400);
  });

  it("M3: another org's key id is a 404", async () => {
    const response = await request(server)
      .get(`/api/analytics/usage?keyId=${otherKeyId}`)
      .set(dashboard());
    expect(response.status).toBe(404);
  });

  it('M4: the usage series is zero-filled', async () => {
    const response = await request(server).get('/api/analytics/usage?range=24h').set(dashboard());
    expect(response.status).toBe(200);
    expect(response.body.series.length).toBeGreaterThanOrEqual(24);
  });

  it('5.10: deleting an unknown webhook is a 404', async () => {
    const bad = await request(server).delete('/api/analytics/webhooks/not-a-uuid').set(dashboard());
    expect(bad.status).toBe(400);
    const missing = await request(server)
      .delete(`/api/analytics/webhooks/${randomUUID()}`)
      .set(dashboard());
    expect(missing.status).toBe(404);
  });

  it('C2: the webhook secret is shown once, then only masked', async () => {
    const created = await request(server)
      .post('/api/analytics/webhooks')
      .set(dashboard())
      .send({ url: 'https://hooks.example.com/reg' });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);

    const list = await request(server).get('/api/analytics/webhooks').set(dashboard());
    const listed = list.body.webhooks.find((w: { id: string }) => w.id === created.body.id);
    expect(listed.secret).toBeUndefined();
    expect(listed.secretPreview).toContain('…');
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
  });

  it('5.23: a short signing secret is rejected', async () => {
    const response = await request(server)
      .post('/api/analytics/webhooks')
      .set(dashboard())
      .send({ url: 'https://hooks.example.com/short', secret: 'abc' });
    expect(response.status).toBe(400);
  });

  it('4.8: the plan endpoint reports real window usage', async () => {
    await request(server).get(`/mock/${slug}/ok`).set('Authorization', `Bearer ${key}`);
    const response = await request(server).get('/api/org/plan').set(dashboard());
    expect(response.status).toBe(200);
    expect(response.body.usage.used).toBeGreaterThanOrEqual(1);
    expect(response.body.usage.limit).toBe(100);
  });

  it('6.1 / 6.2: chaos rules persist, and non-5xx fault codes are refused', async () => {
    const rule = {
      isEnabled: false,
      latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
      errors: { enabled: false, rate5xx: 0, rate429: 0, statusCodes: [503] },
      partition: { enabled: false, dropRate: 0 },
    };

    const ok = await request(server).put('/api/chaos').set(dashboard()).send(rule);
    expect(ok.status).toBe(200);
    const again = await request(server).put('/api/chaos').set(dashboard()).send(rule);
    expect(again.status).toBe(200);

    const rows = await db.select().from(chaosRules).where(eq(chaosRules.orgId, org.orgId));
    expect(rows).toHaveLength(1);

    const bad = await request(server)
      .put('/api/chaos')
      .set(dashboard())
      .send({ ...rule, errors: { ...rule.errors, statusCodes: [200] } });
    expect(bad.status).toBe(400);
  });

  it('4.1 / 6.10: a chaos 429 is not logged as throttling, and an empty message uses the default', async () => {
    await request(server)
      .put('/api/chaos')
      .set(dashboard())
      .send({
        isEnabled: true,
        latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
        errors: { enabled: true, rate5xx: 0, rate429: 1, statusCodes: [503], customMessage: '' },
        partition: { enabled: false, dropRate: 0 },
      });
    await invalidateChaosRule(org.orgId);

    const response = await request(server)
      .get(`/mock/${slug}/ok`)
      .set('Authorization', `Bearer ${key}`);
    expect(response.status).toBe(429);
    expect(response.body.message).toMatch(/Simulated/);

    await flushAll();
    const [row] = await db
      .select()
      .from(requestLogs)
      .where(eq(requestLogs.orgId, org.orgId))
      .orderBy(requestLogs.time);
    const logs = await db.select().from(requestLogs).where(eq(requestLogs.orgId, org.orgId));
    const chaos429 = logs.find((log) => log.statusCode === 429);
    expect(row).toBeDefined();
    expect(chaos429?.rateLimited).toBe(false);
    // 3.18: trace ids are UUIDs, not a per-process counter.
    expect(chaos429?.traceId).toMatch(/^[0-9a-f-]{36}$/);

    await request(server).post('/api/chaos/reset').set(dashboard());
    await invalidateChaosRule(org.orgId);
  });

  it('5.17: a chaos connection drop is still logged', async () => {
    await request(server)
      .put('/api/chaos')
      .set(dashboard())
      .send({
        isEnabled: true,
        latency: { enabled: false, distribution: 'normal', meanMs: 0, stddevMs: 0 },
        errors: { enabled: false, rate5xx: 0, rate429: 0, statusCodes: [503] },
        partition: { enabled: true, dropRate: 1 },
      });
    await invalidateChaosRule(org.orgId);

    await request(server)
      .get(`/mock/${slug}/ok`)
      .set('Authorization', `Bearer ${key}`)
      .catch(() => undefined); // the socket is destroyed on purpose

    await flushAll();
    const logs = await db.select().from(requestLogs).where(eq(requestLogs.orgId, org.orgId));
    expect(logs.some((log) => log.statusCode === 444)).toBe(true);

    await request(server).post('/api/chaos/reset').set(dashboard());
    await invalidateChaosRule(org.orgId);
  });

  it('5.13 / 5.14: a quota alert is sent once, and handed back when delivery fails', async () => {
    const [webhook] = await db
      .insert(orgWebhooks)
      .values({
        orgId: org.orgId,
        url: 'https://hooks.example.com/q',
        secret: 'whsec_' + 'x'.repeat(20),
      })
      .returning();

    // 85 of the free plan's 100 requests used.
    const bucket = `rate:org:${org.orgId}`;
    await redis.del(bucket);
    const now = Date.now();
    for (let i = 0; i < 85; i++) await redis.zadd(bucket, now - i, `m${i}`);

    // Only this webhook is active for the test.
    await db.update(orgWebhooks).set({ isActive: false }).where(eq(orgWebhooks.orgId, org.orgId));
    await db.update(orgWebhooks).set({ isActive: true }).where(eq(orgWebhooks.id, webhook!.id));

    const send = vi.spyOn(webhookTransport, 'send').mockResolvedValue({ status: 200 });
    await Promise.all([checkSingleOrgQuota(org.orgId), checkSingleOrgQuota(org.orgId)]);
    expect(send).toHaveBeenCalledTimes(1);

    // A failed delivery does not record the alert as sent.
    await db
      .update(orgWebhooks)
      .set({ lastAlertedThreshold: null })
      .where(eq(orgWebhooks.id, webhook!.id));
    const other = await db
      .insert(orgWebhooks)
      .values({
        orgId: org.orgId,
        url: 'https://hooks.example.com/q2',
        secret: 'whsec_' + 'y'.repeat(20),
      })
      .returning();
    await db.delete(orgWebhooks).where(eq(orgWebhooks.id, webhook!.id));
    send.mockResolvedValue({ status: 503 });
    await checkSingleOrgQuota(org.orgId);
    const [after] = await db.select().from(orgWebhooks).where(eq(orgWebhooks.id, other[0]!.id));
    expect(after?.lastAlertedThreshold).toBeNull();

    send.mockRestore();
    await redis.del(bucket);
  });
});

describe('chaos sampling (6.5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses one draw, so the configured 5xx rate is exact', () => {
    const config = { enabled: true, rate429: 0.1, rate5xx: 0.05, statusCodes: [503] };

    vi.spyOn(Math, 'random').mockReturnValue(0.12);
    expect(shouldInjectError(config)).toMatchObject({ inject: true, statusCode: 503 });

    vi.spyOn(Math, 'random').mockReturnValue(0.16);
    expect(shouldInjectError(config)).toEqual({ inject: false });

    vi.spyOn(Math, 'random').mockReturnValue(0.05);
    expect(shouldInjectError(config)).toMatchObject({ inject: true, is429: true });
  });

  it('hits the configured rates over many draws', () => {
    const config = { enabled: true, rate429: 0.1, rate5xx: 0.05, statusCodes: [500] };
    let errors5xx = 0;
    const trials = 20_000;
    for (let i = 0; i < trials; i++) {
      const decision = shouldInjectError(config);
      if (decision.inject && !decision.is429) errors5xx++;
    }
    expect(Math.abs(errors5xx / trials - 0.05)).toBeLessThan(0.01);
  });
});
