import type { FastifyInstance } from 'fastify';
import { isProduction } from '../config.js';

/**
 * Baseline security headers.
 *
 * The API serves JSON, so these are the headers that are cheap and universally
 * correct. Two additions since the first version:
 *
 *  - **HSTS** in production. The session cookie is `secure`, but the login POST
 *    and the CSRF token still travel in cleartext on first contact without it.
 *  - **A restrictive CSP**. The API never renders HTML, so `default-src 'none'`
 *    is correct here and costs nothing; it is a second line of defence if a
 *    proxy ever mislabels a response as HTML. The dashboard's own CSP is set by
 *    the Next.js app, which knows what it needs to load.
 */
export function registerSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-DNS-Prefetch-Control', 'off');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-site');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    reply.removeHeader('X-Powered-By');

    if (isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }

    // Authenticated JSON must not be cached by a browser or an intermediary.
    // The mock API is deliberately excluded: it is public, deterministic, and
    // caching it is a feature.
    const isDashboardApi = request.url.startsWith('/api');
    const isAuthRoute = request.url.startsWith('/api/auth');
    if (isDashboardApi || isAuthRoute) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }

    return payload;
  });
}
