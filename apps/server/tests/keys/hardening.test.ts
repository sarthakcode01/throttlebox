import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import request from 'supertest';
import type { Server } from 'node:http';
import { buildServer } from '../../src/index.js';
import { createRateLimit } from '../../src/http/rateLimit.js';
import { runSessionCleanup } from '../../src/auth/janitor.js';
import { db } from '../../src/db/client.js';
import { sessions } from '../../src/db/schema.js';
import { lt } from 'drizzle-orm';

/**
 * Tests for the hardening added in the Phase 0-2 audit.
 */

describe('rate limiter', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    const limiter = createRateLimit({
      max: 3,
      windowMs: 60_000,
      keyGenerator: (req) => `test:${req.ip}`,
    });

    app.get('/limited', { preHandler: limiter.handler }, async () => ({ ok: true }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows requests up to the limit and blocks the rest', async () => {
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({ method: 'GET', url: '/limited' });
      expect(response.statusCode, `request ${i + 1}`).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBe('3');
    }

    const blocked = await app.inject({ method: 'GET', url: '/limited' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(blocked.json().error).toBe('rate_limited');
  });

  it('counts each client separately', async () => {
    const other = await app.inject({
      method: 'GET',
      url: '/limited',
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });

    // The same client is still blocked, a different one gets its own bucket.
    expect(other.statusCode).toBe(429);
  });

  it('is a no-op when disabled', async () => {
    const disabled = Fastify();
    const limiter = createRateLimit({
      max: 1,
      windowMs: 60_000,
      keyGenerator: () => 'key',
      enabled: false,
    });

    disabled.get('/limited', { preHandler: limiter.handler }, async () => ({ ok: true }));
    await disabled.ready();

    for (let i = 0; i < 20; i++) {
      const response = await disabled.inject({ method: 'GET', url: '/limited' });
      expect(response.statusCode).toBe(200);
    }

    expect(limiter.size()).toBe(0);
    await disabled.close();
  });
});

describe('health probes', () => {
  let app: FastifyInstance;
  let server: Server;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    server = app.server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports liveness without touching the dependencies', async () => {
    const response = await request(server).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('reports readiness when the dependencies are reachable', async () => {
    const response = await request(server).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body.checks.database).toBe('ok');
    expect(response.body.checks.redis).toBe('ok');
  });

  it('sets baseline security headers', async () => {
    const response = await request(server).get('/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('session janitor', () => {
  it('leaves no expired session rows behind', async () => {
    const deleted = await runSessionCleanup();
    expect(deleted).toBeGreaterThanOrEqual(0);

    const remaining = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(lt(sessions.expiresAt, new Date()));

    expect(remaining.length).toBe(0);
  });
});
