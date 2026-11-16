import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { getServiceRouter } from '../mock/services.js';
import { resolveChaosRule } from './cache.js';
import { sampleLatency, shouldDropSocket, shouldInjectError } from './sampling.js';

declare module 'fastify' {
  interface FastifyInstance {
    chaosEngine: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function getStandardErrorMessage(status: number): string {
  switch (status) {
    case 500:
      return 'Internal Server Error (Simulated by Throttlebox Chaos Engine)';
    case 502:
      return 'Bad Gateway: Upstream service failed to respond';
    case 503:
      return 'Service Unavailable: Backend server temporarily overloaded';
    case 504:
      return 'Gateway Timeout: Upstream dependency timed out';
    default:
      return `Simulated Fault (HTTP ${status}) from Throttlebox Chaos Engine`;
  }
}

/**
 * Fastify preHandler hook for injecting chaos faults and artificial jitter.
 *
 * Ordered in the pipeline:
 *  1. requireKeyAuth
 *  2. requireScope('mock:read' | 'mock:write')
 *  3. rateLimitMock
 *  4. chaosEngine (Resolves target service -> evaluates partition -> latency -> fault response)
 *  5. Mock Route Handler
 */
export const chaosPlugin = fp(async (fastify) => {
  fastify.decorate('chaosEngine', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.keyAuth;
    if (!auth) {
      return;
    }

    const reqExt = request as unknown as { mockServiceId?: string };
    let serviceId = reqExt.mockServiceId ?? null;

    // Resolve serviceId from route parameters if not already pre-populated
    if (!serviceId) {
      const params = request.params as { serviceSlug?: string } | undefined;
      const serviceSlug = params?.serviceSlug;
      if (serviceSlug) {
        const router = await getServiceRouter(auth.orgId, serviceSlug).catch(() => null);
        if (!router) {
          // If the service does not exist in this tenant, bypass chaos so the route handler
          // can cleanly return 404 (service_not_found) instead of failing or severing sockets.
          return;
        }
        serviceId = router.serviceId;
        reqExt.mockServiceId = serviceId;
      }
    }

    const rule = await resolveChaosRule(auth.orgId, serviceId, auth.keyId).catch((err) => {
      request.log.warn({ err }, '[Chaos] Failed to resolve chaos rule, skipping');
      return null;
    });

    if (!rule || !rule.isEnabled) {
      return;
    }

    // 1. Network partition simulation (TCP socket destroy)
    // reply.hijack() tells Fastify that this hook takes complete control of the stream,
    // halting downstream route handlers and preventing 'write after destroy' runtime errors.
    if (shouldDropSocket(rule.partition)) {
      request.log.warn(
        { orgId: auth.orgId, serviceId, keyId: auth.keyId },
        '[Chaos] Terminating connection abruptly (simulated partition drop)',
      );
      reply.hijack();
      request.raw.destroy();
      return;
    }

    // 2. Artificial latency simulation (Box-Muller normal or uniform distribution)
    const delayMs = sampleLatency(rule.latency);
    if (delayMs > 0) {
      reply.header('X-Throttlebox-Chaos-Latency', `${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      // If the client aborted/closed the socket during artificial delay, abort immediately
      if (request.raw.destroyed) {
        return;
      }
    }

    // 3. Fault response simulation (5xx server errors or simulated 429)
    const errorDecision = shouldInjectError(rule.errors);
    if (errorDecision.inject) {
      const status = errorDecision.statusCode ?? 500;
      reply.header('X-Throttlebox-Chaos-Injected', 'true');

      if (errorDecision.is429) {
        reply.header('Retry-After', '5');
        return reply.code(429).send({
          error: 'simulated_rate_limit',
          message:
            rule.errors.customMessage ??
            'Too Many Requests (Simulated by Throttlebox Chaos Engine)',
        });
      }

      return reply.code(status).send({
        error: 'chaos_fault_injected',
        statusCode: status,
        message: rule.errors.customMessage ?? getStandardErrorMessage(status),
        timestamp: new Date().toISOString(),
      });
    }
  });
});
