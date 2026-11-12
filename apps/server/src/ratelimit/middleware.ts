import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { checkRateLimit } from './limiter.js';
import { getOrgPlan } from './tier.js';

declare module 'fastify' {
  interface FastifyInstance {
    rateLimitMock: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Fastify preHandler hook for sliding-window rate limiting on mock API routes.
 *
 * Ordered pipeline:
 *  1. requireKeyAuth (attaches request.keyAuth)
 *  2. requireScope('mock:read' | 'mock:write')
 *  3. rateLimitMock (tier resolution -> sliding window check -> rate limit headers)
 *  4. Mock Route Handler
 */
export const rateLimitPlugin = fp(async (fastify) => {
  fastify.decorate('rateLimitMock', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.keyAuth;
    if (!auth) {
      return;
    }

    const plan = await getOrgPlan(auth.orgId);
    const effectiveLimit = Math.floor(plan.requestsPerWindow * plan.burstAllowance);

    const result = await checkRateLimit({
      orgId: auth.orgId,
      keyId: auth.keyId,
      limit: effectiveLimit,
      windowSeconds: plan.windowSeconds,
    });

    // Standard rate limit headers (RFC / GitHub / Stripe behavior) on ALL responses
    reply.header('X-RateLimit-Limit', String(result.limit));
    reply.header('X-RateLimit-Remaining', String(result.remaining));
    reply.header('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      const retryAfter = result.retryAfter ?? 1;
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: 'rate_limited',
        message: `Rate limit exceeded. Please retry after ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
      });
    }
  });
});
