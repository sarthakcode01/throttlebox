import type { FastifyPluginAsync } from 'fastify';
import { PLANS, type Plan } from '@throttlebox/shared';
import { z } from 'zod';
import { getOrgPlan, updateOrgPlan } from '../ratelimit/tier.js';

const updatePlanSchema = z.object({
  plan: z.enum(PLANS),
});

export const orgRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/org/plan
  fastify.get('/org/plan', { preHandler: [fastify.requireAuth] }, async (request, reply) => {
    const auth = request.auth;
    if (!auth?.orgId) {
      return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
    }

    const planConfig = await getOrgPlan(auth.orgId);
    return reply.send({ plan: planConfig });
  });

  // PATCH /api/org/plan
  fastify.patch(
    '/org/plan',
    {
      preHandler: [fastify.requireAuth, fastify.requirePermission('org:update_plan')],
    },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      const parsed = updatePlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid plan',
        });
      }

      const updated = await updateOrgPlan(auth.orgId, parsed.data.plan as Plan);
      return reply.send({ ok: true, plan: updated });
    },
  );
};
