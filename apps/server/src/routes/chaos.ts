import type { FastifyPluginAsync } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ChaosBenchmarkResult, ChaosRuleConfig } from '@throttlebox/shared';
import { db } from '../db/client.js';
import { apiKeys, chaosRules, mockServices } from '../db/schema.js';
import { getServiceBySlug } from '../mock/services.js';
import { invalidateChaosRule, resolveChaosRule, toChaosRuleConfig } from '../chaos/cache.js';
import { sampleLatency, shouldDropSocket, shouldInjectError } from '../chaos/sampling.js';

const latencySchema = z
  .object({
    enabled: z.boolean(),
    distribution: z.enum(['fixed', 'normal', 'uniform']).default('normal'),
    meanMs: z.number().min(0).max(30000),
    stddevMs: z.number().min(0).max(10000).default(50),
    minMs: z.number().min(0).max(30000).optional(),
    maxMs: z.number().min(0).max(30000).optional(),
  })
  .refine(
    (data) => {
      if (data.minMs !== undefined && data.maxMs !== undefined) {
        return data.minMs <= data.maxMs;
      }
      return true;
    },
    { message: 'minMs cannot exceed maxMs', path: ['minMs'] },
  );

const errorsSchema = z.object({
  enabled: z.boolean(),
  rate5xx: z.number().min(0).max(1.0).default(0),
  rate429: z.number().min(0).max(1.0).default(0),
  // Server-error codes only. Any integer used to be accepted, and a value
  // outside 100–599 made `reply.code()` throw — the "injected fault" became
  // a real 500 — while 200 made a fault indistinguishable from success.
  statusCodes: z
    .array(z.number().int().min(500).max(599))
    .min(1)
    .max(20)
    .default([500, 502, 503, 504]),
  // An empty message means "use the default" — store it as absent.
  customMessage: z
    .string()
    .max(500)
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
});

const partitionSchema = z.object({
  enabled: z.boolean(),
  dropRate: z.number().min(0).max(1.0).default(0),
});

const updateChaosRuleSchema = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  keyId: z.string().uuid().nullable().optional(),
  isEnabled: z.boolean(),
  latency: latencySchema,
  errors: errorsSchema,
  partition: partitionSchema,
});

const benchmarkSchema = z.object({
  serviceSlug: z.string().min(1).max(60).optional(),
  requestCount: z.number().int().min(10).max(200).default(100),
});

export const chaosRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.requireAuth(request, reply);
    if (reply.sent) return;
    if (!request.auth?.orgId) {
      return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
    }
  });

  // 1. Get Chaos Rules for the Organization
  fastify.get(
    '/chaos',
    { preHandler: [fastify.requirePermission('chaos:read')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;

      const rows = await db.select().from(chaosRules).where(eq(chaosRules.orgId, orgId));

      const rules = rows.map(toChaosRuleConfig);

      // Ensure there is always at least an org-level default rule returned
      let defaultRule = rules.find((r) => !r.serviceId && !r.keyId);
      if (!defaultRule) {
        defaultRule = {
          id: 'default',
          orgId,
          serviceId: null,
          keyId: null,
          isEnabled: false,
          latency: {
            enabled: false,
            distribution: 'normal',
            meanMs: 200,
            stddevMs: 50,
            minMs: 0,
            maxMs: 30000,
          },
          errors: {
            enabled: false,
            rate5xx: 0.0,
            rate429: 0.0,
            statusCodes: [500, 502, 503, 504],
          },
          partition: {
            enabled: false,
            dropRate: 0.0,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      return reply.send({
        defaultRule,
        rules,
      });
    },
  );

  // 2. Upsert Chaos Rule
  fastify.put(
    '/chaos',
    { preHandler: [fastify.requirePermission('chaos:write')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const parsed = updateChaosRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid chaos rule configuration',
        });
      }

      const { serviceId = null, keyId = null, isEnabled, latency, errors, partition } = parsed.data;

      // Multi-tenant verification: Ensure serviceId and keyId belong to this organization
      if (serviceId) {
        const [service] = await db
          .select({ id: mockServices.id })
          .from(mockServices)
          .where(and(eq(mockServices.id, serviceId), eq(mockServices.orgId, orgId)))
          .limit(1);

        if (!service) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Target mock service does not exist or does not belong to your organization',
          });
        }
      }

      if (keyId) {
        const [key] = await db
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
          .limit(1);

        if (!key) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'Target API key does not exist or does not belong to your organization',
          });
        }
      }

      const conditions = [eq(chaosRules.orgId, orgId)];
      if (serviceId) {
        conditions.push(eq(chaosRules.serviceId, serviceId));
      } else {
        conditions.push(isNull(chaosRules.serviceId));
      }

      if (keyId) {
        conditions.push(eq(chaosRules.keyId, keyId));
      } else {
        conditions.push(isNull(chaosRules.keyId));
      }

      const [existing] = await db
        .select({ id: chaosRules.id })
        .from(chaosRules)
        .where(and(...conditions))
        .limit(1);

      let saved: ChaosRuleConfig;

      if (existing) {
        const [updated] = await db
          .update(chaosRules)
          .set({
            isEnabled,
            latency,
            errors,
            partition,
            updatedAt: new Date(),
          })
          .where(eq(chaosRules.id, existing.id))
          .returning();

        if (!updated) {
          throw new Error('Failed to update chaos rule');
        }
        saved = toChaosRuleConfig(updated);
      } else {
        // Insert, or update if a concurrent request created the same scope
        // first. Each scope has exactly one row (see the partial unique
        // indexes), so a lost race used to surface as a 500.
        const scopeTarget =
          !serviceId && !keyId
            ? {
                target: [chaosRules.orgId],
                where: sql`${chaosRules.serviceId} IS NULL AND ${chaosRules.keyId} IS NULL`,
              }
            : serviceId && !keyId
              ? {
                  target: [chaosRules.orgId, chaosRules.serviceId],
                  where: sql`${chaosRules.keyId} IS NULL AND ${chaosRules.serviceId} IS NOT NULL`,
                }
              : !serviceId && keyId
                ? {
                    target: [chaosRules.orgId, chaosRules.keyId],
                    where: sql`${chaosRules.serviceId} IS NULL AND ${chaosRules.keyId} IS NOT NULL`,
                  }
                : { target: [chaosRules.orgId, chaosRules.serviceId, chaosRules.keyId] };

        const [inserted] = await db
          .insert(chaosRules)
          .values({
            orgId,
            serviceId,
            keyId,
            isEnabled,
            latency,
            errors,
            partition,
          })
          .onConflictDoUpdate({
            target: scopeTarget.target,
            ...(scopeTarget.where ? { targetWhere: scopeTarget.where } : {}),
            set: { isEnabled, latency, errors, partition, updatedAt: new Date() },
          })
          .returning();

        if (!inserted) {
          throw new Error('Failed to create chaos rule');
        }
        saved = toChaosRuleConfig(inserted);
      }

      await invalidateChaosRule(orgId, serviceId, keyId);

      return reply.send({ rule: saved });
    },
  );

  // 3. Reset Chaos Rule to Defaults (Disabled)
  fastify.post(
    '/chaos/reset',
    { preHandler: [fastify.requirePermission('chaos:write')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;

      await db
        .update(chaosRules)
        .set({
          isEnabled: false,
          latency: {
            enabled: false,
            distribution: 'normal',
            meanMs: 200,
            stddevMs: 50,
            minMs: 0,
            maxMs: 30000,
          },
          errors: {
            enabled: false,
            rate5xx: 0.0,
            rate429: 0.0,
            statusCodes: [500, 502, 503, 504],
          },
          partition: {
            enabled: false,
            dropRate: 0.0,
          },
          updatedAt: new Date(),
        })
        .where(eq(chaosRules.orgId, orgId));

      await invalidateChaosRule(orgId);

      return reply.send({ success: true, message: 'Chaos engineering controls reset' });
    },
  );

  // 4. "Test Your Resilience" Benchmark Simulator Endpoint
  fastify.post(
    '/chaos/benchmark',
    { preHandler: [fastify.requirePermission('chaos:read')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const parsed = benchmarkSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid benchmark options',
        });
      }

      const { serviceSlug, requestCount = 100 } = parsed.data;

      let targetServiceId: string | null = null;
      if (serviceSlug) {
        const service = await getServiceBySlug(orgId, serviceSlug);
        targetServiceId = service?.id ?? null;
      }

      // Retrieve effective chaos rule for this service or organization
      const rule = await resolveChaosRule(orgId, targetServiceId, null);

      const latencies: number[] = [];
      let successful = 0;
      let errors5xx = 0;
      let throttled429 = 0;
      let dropped = 0;

      const histogram = [
        { bracket: '< 50ms', count: 0 },
        { bracket: '50 - 100ms', count: 0 },
        { bracket: '100 - 250ms', count: 0 },
        { bracket: '250 - 500ms', count: 0 },
        { bracket: '> 500ms', count: 0 },
      ];

      for (let i = 0; i < requestCount; i++) {
        // Base intrinsic mock latency (5-15ms)
        const baseLatency = Math.round(5 + Math.random() * 10);

        if (!rule || !rule.isEnabled) {
          successful++;
          latencies.push(baseLatency);
          continue;
        }

        // 1. Check partition drop
        if (shouldDropSocket(rule.partition)) {
          dropped++;
          continue;
        }

        // 2. Check latency injection
        const chaosDelay = sampleLatency(rule.latency);
        const totalLatency = baseLatency + chaosDelay;
        latencies.push(totalLatency);

        // 3. Check error injection
        const errorDecision = shouldInjectError(rule.errors);
        if (errorDecision.inject) {
          if (errorDecision.is429) {
            throttled429++;
          } else {
            errors5xx++;
          }
        } else {
          successful++;
        }
      }

      // Populate histogram
      for (const lat of latencies) {
        if (lat < 50) histogram[0]!.count++;
        else if (lat < 100) histogram[1]!.count++;
        else if (lat < 250) histogram[2]!.count++;
        else if (lat < 500) histogram[3]!.count++;
        else histogram[4]!.count++;
      }

      latencies.sort((a, b) => a - b);
      const totalRecorded = latencies.length || 1;
      const sum = latencies.reduce((acc, v) => acc + v, 0);
      const meanLatencyMs = Math.round(sum / totalRecorded);
      const p50LatencyMs = latencies[Math.floor(totalRecorded * 0.5)] ?? 0;
      const p95LatencyMs = latencies[Math.floor(totalRecorded * 0.95)] ?? 0;
      const p99LatencyMs = latencies[Math.floor(totalRecorded * 0.99)] ?? 0;

      const result: ChaosBenchmarkResult = {
        totalRequests: requestCount,
        successful,
        errors5xx,
        throttled429,
        dropped,
        meanLatencyMs,
        p50LatencyMs,
        p95LatencyMs,
        p99LatencyMs,
        histogram,
      };

      return reply.send(result);
    },
  );

  // 5. Delete a Scoped Chaos Rule
  fastify.delete(
    '/chaos',
    { preHandler: [fastify.requirePermission('chaos:write')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const querySchema = z.object({
        serviceId: z.string().uuid().optional(),
        keyId: z.string().uuid().optional(),
      });

      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid query parameters',
        });
      }

      const { serviceId = null, keyId = null } = parsed.data;

      const conditions = [eq(chaosRules.orgId, orgId)];
      if (serviceId) {
        conditions.push(eq(chaosRules.serviceId, serviceId));
      } else {
        conditions.push(isNull(chaosRules.serviceId));
      }

      if (keyId) {
        conditions.push(eq(chaosRules.keyId, keyId));
      } else {
        conditions.push(isNull(chaosRules.keyId));
      }

      await db.delete(chaosRules).where(and(...conditions));
      await invalidateChaosRule(orgId, serviceId, keyId);

      return reply.send({ success: true, message: 'Chaos rule deleted' });
    },
  );
};
