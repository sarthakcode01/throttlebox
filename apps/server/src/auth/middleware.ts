import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import type { Role } from '@throttlebox/shared';
import { roleHasPermission } from '@throttlebox/shared';
import { db } from '../db/client.js';
import { orgMembers } from '../db/schema.js';
import { safeEqualString } from '../util/crypto.js';
import { resolveSession, CSRF_COOKIE, SESSION_COOKIE } from './session.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  orgId: string | null;
  role: Role | null;
}

/** Methods that cannot change state and so need no CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (
      permission: string,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// fp() breaks Fastify's encapsulation so this hook and the decorators below
// apply to the root instance — otherwise routes registered in sibling scopes
// (e.g. /api) never see the session.
export const authPlugin = fp(async (fastify) => {
  fastify.decorateRequest('auth', null);

  // Resolve the session on every request. Cheap Redis GET on a miss-free path.
  fastify.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const session = await resolveSession(token);
    if (!session) return;

    // Attach the user's default org + role (first membership).
    //
    // Ordered by creation so the choice is deterministic. Every user has
    // exactly one membership today, but an unordered `limit(1)` would leave
    // the result up to Postgres' plan the moment a second membership exists.
    const [membership] = await db
      .select({
        orgId: orgMembers.orgId,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .where(eq(orgMembers.userId, session.userId))
      .orderBy(orgMembers.createdAt)
      .limit(1);

    request.auth = {
      userId: session.userId,
      sessionId: session.sessionId,
      orgId: membership?.orgId ?? null,
      role: (membership?.role ?? null) as Role | null,
    };
  });

  fastify.decorate('requireAuth', async (request, reply) => {
    if (!request.auth) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
    }
  });

  fastify.decorate('requirePermission', (permission: string) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.auth) {
        return reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
      }
      const { role, orgId } = request.auth;
      if (!role || !orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }
      if (!roleHasPermission(role, permission)) {
        return reply.code(403).send({
          error: 'forbidden',
          message: `Role '${role}' lacks permission '${permission}'`,
        });
      }
      return undefined;
    };
  });

  // ---- CSRF (double submit) -------------------------------------------
  //
  // A state-changing request that is authenticated by the session cookie must
  // also echo the readable CSRF cookie back in the `X-CSRF-Token` header. A
  // cross-site page can cause the browser to send the cookie, but it cannot
  // read the cookie value, so it cannot produce a matching header.
  //
  // Requests carrying an `Authorization` header are skipped: those are
  // authenticated by a bearer token that a browser never attaches on its own,
  // so there is nothing for a third-party site to forge. That is the path the
  // mock API and the in-app playground use.
  fastify.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (request.headers.authorization) return;

    // No session cookie means the request is not cookie-authenticated.
    if (!request.cookies[SESSION_COOKIE]) return;

    const cookieToken = request.cookies[CSRF_COOKIE];
    const headerToken = request.headers['x-csrf-token'];

    if (
      !cookieToken ||
      typeof headerToken !== 'string' ||
      !safeEqualString(cookieToken, headerToken)
    ) {
      await reply
        .code(403)
        .send({ error: 'csrf_failed', message: 'Invalid or missing CSRF token' });
    }
  });
});
