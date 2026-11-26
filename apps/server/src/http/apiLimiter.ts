import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createRateLimit } from './rateLimit.js';
import { config } from '../config.js';

/**
 * A ceiling on the session-authenticated dashboard API.
 *
 * Before this, only `/auth/*` and `/mock/*` were limited. Everything else under
 * `/api` was unbounded, and two of those endpoints are amplifiers:
 * `GET /api/analytics/logs` ran a full-history `count(*)` on the request_logs
 * hypertable, and `POST /api/chaos/benchmark` ran a sampling loop. A `viewer`
 * could issue either in a tight loop.
 *
 * The bucket is keyed by user rather than by IP: the caller is authenticated,
 * so a shared NAT or a rotating proxy should not multiply the allowance.
 */
export const apiLimiterPlugin = fp(async (fastify) => {
  const limiter = createRateLimit({
    max: config.API_RATE_LIMIT_MAX,
    windowMs: config.API_RATE_LIMIT_WINDOW_SECONDS * 1000,
    keyGenerator: (request: FastifyRequest) =>
      request.auth?.userId ? `user:${request.auth.userId}` : `ip:${request.ip}`,
    prefix: 'ratelimit:api',
    message: 'Too many requests. Please slow down and try again.',
  });

  /**
   * Runs after `authPlugin` has resolved the session, so the bucket can be
   * per-user. Applied at `/api` scope rather than globally, because the public
   * mock API has its own plan-based limiter.
   */
  fastify.decorate('apiLimiter', limiter.handler);
});

declare module 'fastify' {
  interface FastifyInstance {
    apiLimiter: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
