import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { config, isProduction, trustProxyCidrs, webOrigins } from './config.js';
import { authPlugin } from './auth/middleware.js';
import { keyAuthPlugin } from './keys/middleware.js';
import { rateLimitPlugin } from './ratelimit/middleware.js';
import { chaosPlugin } from './chaos/middleware.js';
import { startTierPubSub, stopTierPubSub } from './ratelimit/tier.js';
import { startRouterPubSub, stopRouterPubSub } from './mock/services.js';
import { startChaosPubSub, stopChaosPubSub } from './chaos/cache.js';
import { startTouchFlusher, stopTouchFlusher } from './keys/touch.js';
import { startKeyCachePubSub, stopKeyCachePubSub } from './keys/cache.js';
import { registerLenientContentType } from './http/contentType.js';
import { registerErrorHandler } from './http/errorHandler.js';
import { registerHealthRoutes } from './http/health.js';
import { registerSecurityHeaders } from './http/securityHeaders.js';
import { apiLimiterPlugin } from './http/apiLimiter.js';
import { startSessionJanitor, stopSessionJanitor } from './auth/janitor.js';
import { startSessionPubSub, stopSessionPubSub } from './auth/session.js';
import { authRoutes } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';
import { mockRoutes, mockPreviewRoutes } from './routes/mock.js';
import { openApiRoutes } from './routes/openapi.js';
import { serviceRoutes } from './routes/services.js';
import { orgRoutes } from './routes/org.js';
import { analyticsRoutes } from './routes/analytics.js';
import { chaosRoutes } from './routes/chaos.js';
import { playgroundRoutes } from './routes/playground.js';
import { startPlaygroundJanitor, stopPlaygroundJanitor } from './playground/janitor.js';
import {
  startIngestFlusher,
  stopIngestFlusher,
  setQuotaCheckCallback,
} from './analytics/ingest.js';
import { startWebhookOutbox, stopWebhookOutbox } from './analytics/webhookOutbox.js';
import { checkOrgQuotas } from './analytics/quotaMonitor.js';

export async function buildServer(): Promise<FastifyInstance> {
  // Trust `X-Forwarded-For` only from a configured proxy address.
  //
  // `request.ip` is what the API key audit trail records and what the
  // credential limiter buckets on, so trusting the header too broadly is both
  // false evidence and a way to shard brute-force attempts across unlimited
  // apparent IPs. The empty list means nothing is trusted and the real socket
  // peer is used.
  const trustProxy = config.TRUST_PROXY_CIDRS !== '' ? trustProxyCidrs : false;

  const fastify = Fastify({
    logger: {
      level: isProduction ? 'info' : 'debug',
      transport: isProduction ? undefined : { target: 'pino-pretty', options: { colorize: true } },
    },
    trustProxy,
  });

  await fastify.register(cors, {
    // Validated at boot (config.ts): explicit origins only, no wildcard,
    // HTTPS in production. `credentials: true` makes this list a security
    // boundary rather than a convenience.
    origin: webOrigins,
    credentials: true, // required for the session cookie
  });

  await fastify.register(cookie);
  await fastify.register(authPlugin);
  await fastify.register(keyAuthPlugin);
  await fastify.register(rateLimitPlugin);
  await fastify.register(chaosPlugin);
  await fastify.register(apiLimiterPlugin);

  registerLenientContentType(fastify);
  registerErrorHandler(fastify);
  registerSecurityHeaders(fastify);

  // ---- Health ---------------------------------------------------------
  await registerHealthRoutes(fastify);

  // ---- Routes ---------------------------------------------------------
  //
  // Credential endpoints are registered on their own: each already carries a
  // dedicated per-IP limiter, and folding them into the generic per-user bucket
  // would double-count every login.
  await fastify.register(authRoutes, { prefix: '/api' });

  // Everything else under `/api` is session-authenticated and shares one
  // per-user ceiling. The public mock API is registered outside this scope and
  // keeps its own plan-based limiter.
  await fastify.register(
    async (api) => {
      api.addHook('preHandler', async (request, reply) => {
        await fastify.apiLimiter(request, reply);
        if (reply.sent) return;
      });

      await api.register(keyRoutes);
      await api.register(serviceRoutes);
      await api.register(orgRoutes);
      await api.register(analyticsRoutes);
      await api.register(chaosRoutes);
      await api.register(playgroundRoutes);
      await api.register(mockPreviewRoutes);
    },
    { prefix: '/api' },
  );
  // The public mock API and its OpenAPI document live outside /api — they
  // are what a developer's own code calls, with a bearer token.
  await fastify.register(mockRoutes);
  await fastify.register(openApiRoutes);

  return fastify;
}

async function main() {
  const fastify = await buildServer();
  startTouchFlusher();
  startSessionJanitor();
  startPlaygroundJanitor();
  startTierPubSub();
  startRouterPubSub();
  startChaosPubSub();
  startSessionPubSub();
  startKeyCachePubSub();
  setQuotaCheckCallback(checkOrgQuotas);
  startIngestFlusher();
  startWebhookOutbox();

  // Flush buffered writes and purge expired rows on shutdown, so a deploy
  // does not lose them.
  const shutdown = async (signal: string) => {
    fastify.log.info({ signal }, 'shutting down');
    await stopIngestFlusher();
    await stopWebhookOutbox();
    await stopTouchFlusher();
    await stopSessionJanitor();
    stopPlaygroundJanitor();
    await stopTierPubSub();
    await stopRouterPubSub();
    await stopChaosPubSub();
    await stopSessionPubSub();
    await stopKeyCachePubSub();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Only auto-start when run directly, not when imported by tests.
const isDirectRun = process.argv[1]?.includes('index');
if (isDirectRun) {
  void main();
}
