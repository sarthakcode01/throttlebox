import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { config, isProduction } from './config.js';
import { authPlugin } from './auth/middleware.js';
import { keyAuthPlugin } from './keys/middleware.js';
import { startTouchFlusher, stopTouchFlusher } from './keys/touch.js';
import { registerLenientContentType } from './http/contentType.js';
import { registerHealthRoutes } from './http/health.js';
import { registerSecurityHeaders } from './http/securityHeaders.js';
import { startSessionJanitor, stopSessionJanitor } from './auth/janitor.js';
import { authRoutes } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';

export async function buildServer(): Promise<FastifyInstance> {
  // Trust `X-Forwarded-For` only when a proxy count is configured. With
  // `true`, any client could spoof its own address — and the API key audit
  // trail records exactly that address.
  //
  // The callback form is what "trust N hops" means: `hop` counts from the
  // right, where 0 is the address the socket actually connected from. With
  // zero hops configured nothing is trusted, so the real peer address is used.
  const trustProxy = (address: string, hop: number): boolean => hop < config.TRUST_PROXY_HOPS;

  const fastify = Fastify({
    logger: {
      level: isProduction ? 'info' : 'debug',
      transport: isProduction ? undefined : { target: 'pino-pretty', options: { colorize: true } },
    },
    trustProxy,
  });

  await fastify.register(cors, {
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','),
    credentials: true, // required for the session cookie
  });

  await fastify.register(cookie);
  await fastify.register(authPlugin);
  await fastify.register(keyAuthPlugin);

  registerLenientContentType(fastify);
  registerSecurityHeaders(fastify);

  // ---- Health ---------------------------------------------------------
  await registerHealthRoutes(fastify);

  // ---- Routes ---------------------------------------------------------
  await fastify.register(authRoutes, { prefix: '/api' });
  await fastify.register(keyRoutes, { prefix: '/api' });

  return fastify;
}

async function main() {
  const fastify = await buildServer();
  startTouchFlusher();
  startSessionJanitor();

  // Flush buffered writes and purge expired rows on shutdown, so a deploy
  // does not lose them.
  const shutdown = async (signal: string) => {
    fastify.log.info({ signal }, 'shutting down');
    await stopTouchFlusher();
    await stopSessionJanitor();
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
