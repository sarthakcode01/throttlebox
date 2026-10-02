import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { and, eq } from 'drizzle-orm';
import type { Role } from '@throttlebox/shared';
import { roleHasPermission } from '@throttlebox/shared';
import { db } from '../db/client.js';
import { orgMembers } from '../db/schema.js';
import { resolveSession, SESSION_COOKIE } from './session.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  orgId: string | null;
  role: Role | null;
}

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
    const [membership] = await db
      .select({
        orgId: orgMembers.orgId,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .where(eq(orgMembers.userId, session.userId))
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
});

/** Helper: fetch the membership for a specific org, for org-scoped routes. */
export async function membershipForOrg(userId: string, orgId: string) {
  const [row] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.orgId, orgId)))
    .limit(1);
  return row ?? null;
}
