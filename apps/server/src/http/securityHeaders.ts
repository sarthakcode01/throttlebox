import type { FastifyInstance } from 'fastify';
import { isProduction } from '../config.js';

/**
 * Baseline security headers.
 *
 * The API serves JSON and a Next.js frontend, so the strictest CSP that
 * still allows the dashboard to work is set by the web app itself. These are
 * the headers that are cheap and universally correct.
 */
export function registerSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-DNS-Prefetch-Control', 'off');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    // Only over real TLS deployments; HSTS on plain-http localhost would pin
    // the browser to https for a host that does not serve it.
    if (isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    reply.removeHeader('X-Powered-By');
    return payload;
  });
}
