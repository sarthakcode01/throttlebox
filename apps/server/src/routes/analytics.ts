import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  getErrorsBreakdown,
  getLatencySeries,
  getOverview,
  getRecentLogs,
  getUsageSeries,
} from '../analytics/service.js';
import type { TimeRange } from '../analytics/types.js';
import {
  createOrgWebhook,
  deleteOrgWebhook,
  listOrgWebhooks,
  testOrgWebhook,
} from '../analytics/webhooks.js';

const rangeSchema = z.enum(['1h', '24h', '7d', '30d']).default('24h');

export const analyticsRoutes: FastifyPluginAsync = async (fastify) => {
  // Ensure caller has active session and valid orgId
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.requireAuth(request, reply);
    if (reply.sent) return;
    if (!request.auth?.orgId) {
      return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
    }
  });

  // 1. Overview metrics
  fastify.get(
    '/analytics/overview',
    { preHandler: [fastify.requirePermission('analytics:read')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const query = request.query as { range?: string };
      const parsedRange = rangeSchema.safeParse(query.range);
      const range = (parsedRange.success ? parsedRange.data : '24h') as TimeRange;

      const overview = await getOverview(orgId, range);
      return reply.send(overview);
    },
  );

  // 2. Usage time-series
  fastify.get(
    '/analytics/usage',
    { preHandler: [fastify.requirePermission('analytics:read')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const query = request.query as { range?: string; keyId?: string; serviceId?: string };
      const parsedRange = rangeSchema.safeParse(query.range);
      const range = (parsedRange.success ? parsedRange.data : '24h') as TimeRange;

      const series = await getUsageSeries(orgId, range, query.keyId, query.serviceId);
      return reply.send({ series });
    },
  );

  // 3. Latency distribution (p50, p95, p99)
  fastify.get(
    '/analytics/latency',
    { preHandler: [fastify.requirePermission('analytics:read')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const query = request.query as { range?: string };
      const parsedRange = rangeSchema.safeParse(query.range);
      const range = (parsedRange.success ? parsedRange.data : '24h') as TimeRange;

      const series = await getLatencySeries(orgId, range);
      return reply.send({ series });
    },
  );

  // 4. Status and Error breakdown
  fastify.get(
    '/analytics/errors',
    { preHandler: [fastify.requirePermission('analytics:read')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const query = request.query as { range?: string };
      const parsedRange = rangeSchema.safeParse(query.range);
      const range = (parsedRange.success ? parsedRange.data : '24h') as TimeRange;

      const breakdown = await getErrorsBreakdown(orgId, range);
      return reply.send(breakdown);
    },
  );

  // 5. Recent Request Logs
  fastify.get(
    '/analytics/logs',
    { preHandler: [fastify.requirePermission('analytics:read')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const query = request.query as { limit?: string; offset?: string };
      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;

      const result = await getRecentLogs(orgId, limit, offset);
      return reply.send(result);
    },
  );

  // 6. List Webhooks
  fastify.get(
    '/analytics/webhooks',
    { preHandler: [fastify.requirePermission('analytics:read')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const webhooks = await listOrgWebhooks(orgId);
      return reply.send({ webhooks });
    },
  );

  // 7. Create Webhook
  const createWebhookSchema = z.object({
    url: z.string().url('A valid URL is required'),
    secret: z.string().optional(),
  });

  fastify.post(
    '/analytics/webhooks',
    { preHandler: [fastify.requirePermission('analytics:write')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const parsed = createWebhookSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid input',
        });
      }

      const webhook = await createOrgWebhook(orgId, parsed.data.url, parsed.data.secret);
      return reply.code(201).send(webhook);
    },
  );

  // 8. Delete Webhook
  fastify.delete(
    '/analytics/webhooks/:id',
    { preHandler: [fastify.requirePermission('analytics:write')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const { id } = request.params as { id: string };

      await deleteOrgWebhook(orgId, id);
      return reply.send({ success: true });
    },
  );

  // 9. Test Webhook Ping
  fastify.post(
    '/analytics/webhooks/:id/test',
    { preHandler: [fastify.requirePermission('analytics:write')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const { id } = request.params as { id: string };

      const result = await testOrgWebhook(orgId, id);
      return reply.send(result);
    },
  );
};
