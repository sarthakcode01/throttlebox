import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { chaosPlugin } from '../../src/chaos/middleware.js';
import * as cacheModule from '../../src/chaos/cache.js';
import * as mockServicesModule from '../../src/mock/services.js';
import type { ChaosRuleConfig } from '@throttlebox/shared';

describe('chaosPlugin Fastify preHandler hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  function makeMockRule(overrides: Partial<ChaosRuleConfig> = {}): ChaosRuleConfig {
    return {
      id: 'rule-1',
      orgId: 'org-test',
      serviceId: null,
      keyId: null,
      isEnabled: true,
      latency: {
        enabled: false,
        distribution: 'normal',
        meanMs: 200,
        stddevMs: 50,
      },
      errors: {
        enabled: false,
        rate5xx: 0.0,
        rate429: 0.0,
        statusCodes: [500],
      },
      partition: {
        enabled: false,
        dropRate: 0.0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('permits requests transparently when chaos is disabled', async () => {
    const app = Fastify();
    await app.register(chaosPlugin);

    vi.spyOn(cacheModule, 'resolveChaosRule').mockResolvedValue(makeMockRule({ isEnabled: false }));

    app.get('/test', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'k1',
            orgId: 'org-test',
            familyId: 'f1',
            env: 'test',
            scopes: ['mock:read'],
          };
        },
        app.chaosEngine,
      ],
      handler: async () => ({ ok: true }),
    });

    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-throttlebox-chaos-injected']).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('injects 5xx error response when chaos error rate triggers', async () => {
    const app = Fastify();
    await app.register(chaosPlugin);

    vi.spyOn(cacheModule, 'resolveChaosRule').mockResolvedValue(
      makeMockRule({
        isEnabled: true,
        errors: {
          enabled: true,
          rate5xx: 1.0, // 100% errors
          rate429: 0.0,
          statusCodes: [503],
          customMessage: 'Custom chaos service unavailable',
        },
      }),
    );

    app.get('/test', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'k1',
            orgId: 'org-test',
            familyId: 'f1',
            env: 'test',
            scopes: ['mock:read'],
          };
        },
        app.chaosEngine,
      ],
      handler: async () => ({ ok: true }),
    });

    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(503);
    expect(res.headers['x-throttlebox-chaos-injected']).toBe('true');
    const body = JSON.parse(res.body) as { error: string; message: string; statusCode: number };
    expect(body.error).toBe('chaos_fault_injected');
    expect(body.statusCode).toBe(503);
    expect(body.message).toBe('Custom chaos service unavailable');
  });

  it('injects simulated 429 status code with Retry-After header', async () => {
    const app = Fastify();
    await app.register(chaosPlugin);

    vi.spyOn(cacheModule, 'resolveChaosRule').mockResolvedValue(
      makeMockRule({
        isEnabled: true,
        errors: {
          enabled: true,
          rate5xx: 0.0,
          rate429: 1.0, // 100% 429
          statusCodes: [500],
        },
      }),
    );

    app.get('/test', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'k1',
            orgId: 'org-test',
            familyId: 'f1',
            env: 'test',
            scopes: ['mock:read'],
          };
        },
        app.chaosEngine,
      ],
      handler: async () => ({ ok: true }),
    });

    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(429);
    expect(res.headers['x-throttlebox-chaos-injected']).toBe('true');
    expect(res.headers['retry-after']).toBe('5');
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('simulated_rate_limit');
  });

  it('attaches chaos latency header when latency is sampled', async () => {
    const app = Fastify();
    await app.register(chaosPlugin);

    vi.spyOn(cacheModule, 'resolveChaosRule').mockResolvedValue(
      makeMockRule({
        isEnabled: true,
        latency: {
          enabled: true,
          distribution: 'fixed',
          meanMs: 25,
          stddevMs: 0,
        },
      }),
    );

    app.get('/test', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'k1',
            orgId: 'org-test',
            familyId: 'f1',
            env: 'test',
            scopes: ['mock:read'],
          };
        },
        app.chaosEngine,
      ],
      handler: async () => ({ ok: true }),
    });

    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-throttlebox-chaos-latency']).toBe('25ms');
  });

  it('resolves serviceId via route params serviceSlug to match service-scoped rules', async () => {
    const app = Fastify();
    await app.register(chaosPlugin);

    vi.spyOn(mockServicesModule, 'getServiceRouter').mockResolvedValue({
      serviceId: 'srv-12345',
      routes: [],
      match: () => null,
    });

    const resolveSpy = vi
      .spyOn(cacheModule, 'resolveChaosRule')
      .mockResolvedValue(makeMockRule({ isEnabled: false }));

    app.get('/mock/:serviceSlug/*', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'k1',
            orgId: 'org-test',
            familyId: 'f1',
            env: 'test',
            scopes: ['mock:read'],
          };
        },
        app.chaosEngine,
      ],
      handler: async () => ({ ok: true }),
    });

    await app.inject({ method: 'GET', url: '/mock/payments/checkout' });

    expect(resolveSpy).toHaveBeenCalledWith('org-test', 'srv-12345', 'k1');
  });

  it('bypasses chaos when service does not exist in the tenant to allow 404 response', async () => {
    const app = Fastify();
    await app.register(chaosPlugin);

    vi.spyOn(mockServicesModule, 'getServiceRouter').mockResolvedValue(null);

    const resolveSpy = vi.spyOn(cacheModule, 'resolveChaosRule');

    app.get('/mock/:serviceSlug/*', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'k1',
            orgId: 'org-test',
            familyId: 'f1',
            env: 'test',
            scopes: ['mock:read'],
          };
        },
        app.chaosEngine,
      ],
      handler: async (_req, reply) => reply.code(404).send({ error: 'service_not_found' }),
    });

    const res = await app.inject({ method: 'GET', url: '/mock/non-existent-service/test' });

    expect(res.statusCode).toBe(404);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('hijacks response and destroys socket on network partition drop without executing handler', async () => {
    const app = Fastify();
    await app.register(chaosPlugin);

    vi.spyOn(cacheModule, 'resolveChaosRule').mockResolvedValue(
      makeMockRule({
        isEnabled: true,
        partition: {
          enabled: true,
          dropRate: 1.0, // 100% drop
        },
      }),
    );

    let handlerExecuted = false;

    app.get('/test', {
      preHandler: [
        async (req) => {
          req.keyAuth = {
            keyId: 'k1',
            orgId: 'org-test',
            familyId: 'f1',
            env: 'test',
            scopes: ['mock:read'],
          };
        },
        app.chaosEngine,
      ],
      handler: async () => {
        handlerExecuted = true;
        return { ok: true };
      },
    });

    try {
      await app.inject({ method: 'GET', url: '/test' });
    } catch {
      // Expected to fail inject because connection is destroyed
    }

    expect(handlerExecuted).toBe(false);
  });

  it('allows service-scoped disabled rule to override an active org default rule in resolveChaosRule', async () => {
    const serviceRule = makeMockRule({
      id: 'rule-srv',
      serviceId: 'srv-1',
      isEnabled: false, // specifically disabled for this service
    });

    vi.spyOn(cacheModule.chaosCache, 'getCachedChaosRule').mockImplementation(
      async (_orgId, sId) => {
        if (sId === 'srv-1') {
          return serviceRule;
        }
        return makeMockRule({
          id: 'rule-org',
          isEnabled: true, // org has chaos enabled
          errors: { enabled: true, rate5xx: 1.0, rate429: 0.0, statusCodes: [500] },
        });
      },
    );

    const resolved = await cacheModule.resolveChaosRule('org-test', 'srv-1', null);
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe('rule-srv');
    expect(resolved?.isEnabled).toBe(false); // Cleanly overrides org rule!
  });
});
