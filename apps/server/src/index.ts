import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { config, isProduction, isTest } from './config.js';
import { createRateLimit } from './http/rateLimit.js';
import { authPlugin } from './auth/middleware.js';
import { keyAuthPlugin } from './keys/middleware.js';
import { rateLimitPlugin } from './ratelimit/middleware.js';
import { chaosPlugin } from './chaos/middleware.js';
import { startTierPubSub, stopTierPubSub } from './ratelimit/tier.js';
import { startRouterPubSub, stopRouterPubSub } from './mock/services.js';
import { startChaosPubSub, stopChaosPubSub } from './chaos/cache.js';
import { startTouchFlusher, stopTouchFlusher } from './keys/touch.js';
import { registerLenientContentType } from './http/contentType.js';
import { registerErrorHandler } from './http/errorHandler.js';
import { registerHealthRoutes } from './http/health.js';
import { registerSecurityHeaders } from './http/securityHeaders.js';
import { startSessionJanitor, stopSessionJanitor } from './auth/janitor.js';
import { authRoutes } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';
import { mockRoutes, mockPreviewRoutes } from './routes/mock.js';
import { openApiRoutes } from './routes/openapi.js';
import { serviceRoutes } from './routes/services.js';
import { orgRoutes } from './routes/org.js';
import { analyticsRoutes } from './routes/analytics.js';
import { chaosRoutes } from './routes/chaos.js';
import {
  startIngestFlusher,
  stopIngestFlusher,
  setQuotaCheckCallback,
} from './analytics/ingest.js';
import { checkOrgQuotas } from './analytics/quotaMonitor.js';
import { telemetryPlugin } from './analytics/telemetry.js';

/** How long shutdown may take before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * Which peers may set `X-Forwarded-For`.
 *
 * Preferred: an explicit list of proxy addresses or CIDR ranges, so the
 * header is only honoured on connections that really come from a proxy.
 *
 * Fallback: a hop count. The callback form is what "trust N hops" means:
 * `hop` counts from the right, where 0 is the address the socket actually
 * connected from. With zero hops nothing is trusted, so the real peer
 * address is used. `true` is never used — any client could spoof its own
 * address, and the API key audit trail records exactly that address.
 */
function trustProxySetting(): string[] | ((address: string, hop: number) => boolean) {
  if (config.TRUSTED_PROXIES.length > 0) return config.TRUSTED_PROXIES;
  return (_address: string, hop: number): boolean => hop < config.TRUST_PROXY_HOPS;
}

/**
 * A ceiling on the dashboard API, per signed-in user (or per address before
 * sign-in). The mock API and the credential endpoints have their own
 * limiters; everything else under /api was unthrottled.
 */
const dashboardLimiter = createRateLimit({
  max: 600,
  windowMs: 60_000,
  keyGenerator: (request) => `dashboard:${request.auth?.userId ?? request.ip}`,
  enabled: !isTest,
});

/** The benchmark is pure CPU work per call, so it gets a much lower ceiling. */
const benchmarkLimiter = createRateLimit({
  max: 20,
  windowMs: 60_000,
  keyGenerator: (request) => `benchmark:${request.auth?.userId ?? request.ip}`,
  enabled: !isTest,
  message: 'Too many benchmark runs. Please wait a minute.',
});

const OWN_LIMITER_ROUTES = new Set(['/api/auth/login', '/api/auth/register']);

export async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: isProduction ? 'info' : 'debug',
      transport: isProduction ? undefined : { target: 'pino-pretty', options: { colorize: true } },
    },
    trustProxy: trustProxySetting(),
    // Request ids double as analytics trace ids. Fastify's default counter
    // (`req-1`, `req-2`, …) restarts with the process and repeats on every
    // instance.
    genReqId: () => randomUUID(),
  });

  await fastify.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true, // required for the session cookie
  });

  await fastify.register(cookie);
  await fastify.register(telemetryPlugin);
  await fastify.register(authPlugin);
  await fastify.register(keyAuthPlugin);
  await fastify.register(rateLimitPlugin);
  await fastify.register(chaosPlugin);

  // Runs after the session hook, so the limiter can key on the user.
  fastify.addHook('onRequest', async (request, reply) => {
    const path = (request.raw.url ?? '').split('?')[0] ?? '';
    if (!path.startsWith('/api/') || OWN_LIMITER_ROUTES.has(path)) return;

    if (path === '/api/chaos/benchmark') {
      await benchmarkLimiter.handler(request, reply);
      if (reply.sent) return;
    }
    await dashboardLimiter.handler(request, reply);
  });

  registerLenientContentType(fastify);
  registerErrorHandler(fastify);
  registerSecurityHeaders(fastify);

  // ---- Health ---------------------------------------------------------
  await registerHealthRoutes(fastify);

  // ---- Routes ---------------------------------------------------------
  await fastify.register(authRoutes, { prefix: '/api' });
  await fastify.register(keyRoutes, { prefix: '/api' });
  await fastify.register(serviceRoutes, { prefix: '/api' });
  await fastify.register(orgRoutes, { prefix: '/api' });
  await fastify.register(analyticsRoutes, { prefix: '/api' });
  await fastify.register(chaosRoutes, { prefix: '/api' });
  await fastify.register(mockPreviewRoutes, { prefix: '/api' });

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
  startTierPubSub();
  startRouterPubSub();
  startChaosPubSub();
  setQuotaCheckCallback(checkOrgQuotas);
  startIngestFlusher();

  // Flush buffered writes and purge expired rows on shutdown, so a deploy
  // does not lose them.
  //
  // The server closes first: `close()` stops accepting connections and waits
  // for in-flight requests, and those requests still write telemetry and
  // `last_used_at`. Flushing before that dropped whatever they recorded.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    fastify.log.info({ signal }, 'shutting down');

    // A hung dependency must not keep a draining instance alive forever.
    setTimeout(() => {
      fastify.log.error('shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    const steps: [string, () => Promise<unknown>][] = [
      ['http', () => fastify.close()],
      ['ingest', stopIngestFlusher],
      ['touch', stopTouchFlusher],
      ['janitor', stopSessionJanitor],
      ['tier-pubsub', stopTierPubSub],
      ['router-pubsub', stopRouterPubSub],
      ['chaos-pubsub', stopChaosPubSub],
    ];

    let failed = false;
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (err) {
        failed = true;
        fastify.log.error({ err, step: name }, 'shutdown step failed');
      }
    }
    process.exit(failed ? 1 : 0);
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

// Only auto-start when this file is the entry point, not when imported by
// tests. Comparing resolved paths, rather than looking for "index" in argv,
// survives a rename and does not fire for an unrelated entry file.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main();
}
