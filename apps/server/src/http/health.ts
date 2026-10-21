import type { FastifyInstance } from 'fastify';
import { sql } from '../db/client.js';
import { redis } from '../db/redis.js';

/**
 * Liveness and readiness probes.
 *
 * They answer different questions, and conflating them causes outages:
 *
 *  - `/health` is liveness. The process is up and the event loop is turning.
 *    A failing dependency must NOT fail this, or a brief Redis blip would
 *    make the orchestrator kill healthy instances.
 *
 *  - `/health/ready` is readiness. The dependencies this service needs are
 *    actually reachable, so the instance should receive traffic.
 */
export async function registerHealthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async () => ({
    ok: true,
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  }));

  fastify.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'failed'> = {};

    try {
      await sql`select 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'failed';
    }

    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'failed';
    }

    const ready = Object.values(checks).every((status) => status === 'ok');

    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}
