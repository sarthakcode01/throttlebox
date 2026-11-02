import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { rateLimitPlugin } from '../../src/ratelimit/middleware.js';
import * as limiterModule from '../../src/ratelimit/limiter.js';
import * as tierModule from '../../src/ratelimit/tier.js';
import { PLAN_CONFIGS } from '@throttlebox/shared';

describe('rateLimitPlugin preHandler hook', () => {
  it('sets X-RateLimit-* headers and permits request when under limit', async () => {
    const app = Fastify();
    await app.register(rateLimitPlugin);

    vi.spyOn(tierModule, 'getOrgPlan').mockResolvedValue(PLAN_CONFIGS.free);
    vi.spyOn(limiterModule, 'checkRateLimit').mockResolvedValue({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: 1720000000,
    });

    app.get('/test', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'key-1',
            orgId: 'org-1',
            familyId: 'fam-1',
            env: 'test',
            scopes: ['mock:read'],
          };
        },
        app.rateLimitMock,
      ],
      handler: async () => ({ ok: true }),
    });

    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('100');
    expect(res.headers['x-ratelimit-remaining']).toBe('99');
    expect(res.headers['x-ratelimit-reset']).toBe('1720000000');
    expect(res.headers['retry-after']).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('sets 429 status, Retry-After header, and error body when over limit', async () => {
    const app = Fastify();
    await app.register(rateLimitPlugin);

    vi.spyOn(tierModule, 'getOrgPlan').mockResolvedValue(PLAN_CONFIGS.free);
    vi.spyOn(limiterModule, 'checkRateLimit').mockResolvedValue({
      allowed: false,
      limit: 100,
      remaining: 0,
      resetAt: 1720000042,
      retryAfter: 42,
    });

    app.get('/test', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'key-1',
            orgId: 'org-1',
            familyId: 'fam-1',
            env: 'test',
            scopes: ['mock:read'],
          };
        },
        app.rateLimitMock,
      ],
      handler: async () => ({ ok: true }),
    });

    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe('100');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.headers['x-ratelimit-reset']).toBe('1720000042');
    expect(res.headers['retry-after']).toBe('42');

    const body = JSON.parse(res.body) as { error: string; message: string };
    expect(body.error).toBe('rate_limited');
    expect(body.message).toContain('Please retry after 42 seconds');
  });

  it('uses burst allowance when calculating effective limit', async () => {
    const app = Fastify();
    await app.register(rateLimitPlugin);

    vi.spyOn(tierModule, 'getOrgPlan').mockResolvedValue(PLAN_CONFIGS.pro);
    const checkSpy = vi.spyOn(limiterModule, 'checkRateLimit').mockResolvedValue({
      allowed: true,
      limit: 6000,
      remaining: 5999,
      resetAt: 1720000000,
    });

    app.get('/test', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'key-pro',
            orgId: 'org-pro',
            familyId: 'fam-pro',
            env: 'live',
            scopes: ['mock:read'],
          };
        },
        app.rateLimitMock,
      ],
      handler: async () => ({ ok: true }),
    });

    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(200);
    // 5000 * 1.2 = 6000
    expect(checkSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: 'key-pro',
        limit: 6000,
        windowSeconds: 3600,
      }),
    );
  });
});
