import type { FastifyInstance } from 'fastify';

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
    reply.removeHeader('X-Powered-By');
    return payload;
  });
}
