import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { KeyScope } from '@throttlebox/shared';
import { verifyKey, type AuthKeyContext } from './verify.js';

declare module 'fastify' {
  interface FastifyRequest {
    keyAuth: AuthKeyContext | null;
  }
  interface FastifyInstance {
    requireKeyAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireScope: (scope: KeyScope) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Extract the raw key from the Authorization header.
 *
 * Only the header is accepted. A key in a query string would end up in access
 * logs, browser history, and referrer headers.
 */
export function extractBearerKey(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

// fp() breaks encapsulation so the decorators apply to the root instance.
export const keyAuthPlugin = fp(async (fastify) => {
  fastify.decorateRequest('keyAuth', null);

  fastify.decorate('requireKeyAuth', async (request, reply) => {
    const raw = extractBearerKey(request);

    if (!raw) {
      return reply
        .code(401)
        .send({ error: 'unauthorized', message: 'A valid API key is required' });
    }

    const context = await verifyKey(raw);

    if (!context) {
      // One response for every failure mode — a different message per cause
      // would be a free oracle.
      return reply
        .code(401)
        .send({ error: 'unauthorized', message: 'A valid API key is required' });
    }

    request.keyAuth = context;
    return undefined;
  });

  fastify.decorate('requireScope', (scope: KeyScope) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const context = request.keyAuth;
      if (!context) {
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: 'A valid API key is required' });
      }

      if (!context.scopes.includes(scope)) {
        return reply.code(403).send({
          error: 'forbidden',
          message: `This API key does not have the '${scope}' scope`,
        });
      }

      return undefined;
    };
  });
});
