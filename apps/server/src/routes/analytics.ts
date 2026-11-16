import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { apiKeys, mockServices } from '../db/schema.js';
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
  isValidWebhookUrl,
  listOrgWebhooks,
  MIN_WEBHOOK_SECRET_LENGTH,
  testOrgWebhook,
} from '../analytics/webhooks.js';

const rangeSchema = z.enum(['1h', '24h', '7d', '30d']).default('24h');

const usageQuerySchema = z.object({
  range: z.string().optional(),
  keyId: z.string().uuid('keyId must be a UUID').optional(),
  serviceId: z.string().uuid('serviceId must be a UUID').optional(),
});

const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const idParamsSchema = z.object({ id: z.string().uuid('Invalid webhook id') });

function parseRange(raw: unknown): TimeRange {
  const parsed = rangeSchema.safeParse(raw);
  return (parsed.success ? parsed.data : '24h') as TimeRange;
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'validation_error', message });
}

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
      const range = parseRange((request.query as { range?: string }).range);

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
      const query = usageQuerySchema.safeParse(request.query);
      if (!query.success) {
        return badRequest(reply, query.error.issues[0]?.message ?? 'Invalid query');
      }
      const { keyId, serviceId } = query.data;

      // A filter on another org's key or service used to return an empty
      // series — an oracle for whether the id exists. Check ownership and
      // answer 404 for anything that is not this org's.
      if (keyId) {
        const [key] = await db
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
          .limit(1);
        if (!key) return reply.code(404).send({ error: 'not_found', message: 'API key not found' });
      }
      if (serviceId) {
        const [service] = await db
          .select({ id: mockServices.id })
          .from(mockServices)
          .where(and(eq(mockServices.id, serviceId), eq(mockServices.orgId, orgId)))
          .limit(1);
        if (!service) {
          return reply.code(404).send({ error: 'not_found', message: 'Service not found' });
        }
      }

      const series = await getUsageSeries(orgId, parseRange(query.data.range), keyId, serviceId);
      return reply.send({ series });
    },
  );

  // 3. Latency distribution (p50, p95, p99)
  fastify.get(
    '/analytics/latency',
    { preHandler: [fastify.requirePermission('analytics:read')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const range = parseRange((request.query as { range?: string }).range);

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
      const range = parseRange((request.query as { range?: string }).range);

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
      // `parseInt('abc')` used to reach the query as `LIMIT NaN` and fail.
      const query = logsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return badRequest(reply, query.error.issues[0]?.message ?? 'Invalid pagination');
      }

      const result = await getRecentLogs(orgId, query.data.limit, query.data.offset);
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
    url: z.string().url('A valid URL is required').max(2048),
    secret: z
      .string()
      .trim()
      .min(
        MIN_WEBHOOK_SECRET_LENGTH,
        `A signing secret needs at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
      )
      .max(200)
      .optional()
      .or(z.literal('').transform(() => undefined)),
  });

  fastify.post(
    '/analytics/webhooks',
    { preHandler: [fastify.requirePermission('analytics:write')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const parsed = createWebhookSchema.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid input');
      }

      const urlCheck = isValidWebhookUrl(parsed.data.url);
      if (!urlCheck.valid) {
        return reply.code(400).send({
          error: 'invalid_webhook_url',
          message: urlCheck.reason ?? 'Webhook URL is not permitted for security reasons',
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
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'Invalid webhook id');

      const deleted = await deleteOrgWebhook(orgId, params.data.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'not_found', message: 'Webhook not found' });
      }
      return reply.send({ success: true });
    },
  );

  // 9. Test Webhook Ping
  fastify.post(
    '/analytics/webhooks/:id/test',
    { preHandler: [fastify.requirePermission('analytics:write')] },
    async (request, reply) => {
      const orgId = request.auth!.orgId!;
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'Invalid webhook id');

      const result = await testOrgWebhook(orgId, params.data.id);
      if (!result) {
        return reply.code(404).send({ error: 'not_found', message: 'Webhook not found' });
      }
      return reply.send(result);
    },
  );
};
