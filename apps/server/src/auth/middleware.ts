import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import type { Role } from '@throttlebox/shared';
import { roleHasPermission } from '@throttlebox/shared';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { orgMembers } from '../db/schema.js';
import { safeEqualString } from '../util/crypto.js';
import {
  hashUserAgent,
  resolveSession,
  updateSessionRecord,
  CSRF_COOKIE,
  SESSION_COOKIE,
} from './session.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  orgId: string | null;
  role: Role | null;
  /** Absolute session expiry, when known. */
  expiresAt: Date | null;
}

/** Methods that cannot change state and so need no CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints that start a session rather than act on one. They are protected
 * by an Origin check instead of the double-submit token, because a caller
 * with a stale session cookie may have no CSRF cookie to echo.
 */
const SESSION_START_ROUTES = new Set(['/api/auth/login', '/api/auth/register']);

/**
 * How long a cached role stays trusted before `org_members` is read again.
 *
 * Without a bound, a demoted or removed member kept their old permissions
 * for as long as they kept the session alive.
 */
export const MEMBERSHIP_REVALIDATE_MS = 60_000;

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

function pathOf(request: FastifyRequest): string {
  return (request.raw.url ?? request.url).split('?')[0] ?? '';
}

// fp() breaks Fastify's encapsulation so this hook and the decorators below
// apply to the root instance — otherwise routes registered in sibling scopes
// (e.g. /api) never see the session.
export const authPlugin = fp(async (fastify) => {
  fastify.decorateRequest('auth', null);

  // Resolve the session on every request. Cheap Redis GET on a miss-free path.
  fastify.addHook('onRequest', async (request) => {
    // A request that carries a bearer token is authenticated by that token
    // and nothing else. Letting a cookie authenticate it too would mean the
    // CSRF exemption for bearer requests also covered cookie sessions.
    if (request.headers.authorization) return;

    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const session = await resolveSession(token);
    if (!session) return;

    let orgId = session.orgId ?? null;
    let role = (session.role ?? null) as Role | null;

    const checkedAt = session.membershipCheckedAt ?? 0;
    if (Date.now() - checkedAt > MEMBERSHIP_REVALIDATE_MS) {
      const [membership] = await db
        .select({
          orgId: orgMembers.orgId,
          role: orgMembers.role,
        })
        .from(orgMembers)
        .where(eq(orgMembers.userId, session.userId))
        .orderBy(orgMembers.createdAt)
        .limit(1);

      orgId = membership?.orgId ?? null;
      role = (membership?.role ?? null) as Role | null;

      // Cache the answer even when it is "no membership", so a user without
      // an org does not cost a query on every request.
      void updateSessionRecord(token, {
        ...session,
        orgId,
        role,
        membershipCheckedAt: Date.now(),
      }).catch((err) => {
        request.log.warn({ err }, 'Failed to warm session record cache');
      });
    }

    // Sessions are bearer tokens in a cookie. A token presented by a
    // different client than the one it was issued to is worth knowing
    // about, but browsers change their User-Agent on every update, so it is
    // logged rather than rejected.
    const presented = hashUserAgent(request.headers['user-agent']);
    if (session.userAgentHash && presented !== session.userAgentHash) {
      request.log.warn(
        { sessionId: session.sessionId, userId: session.userId },
        'Session presented by a different User-Agent than the one it was issued to',
      );
    }

    request.auth = {
      userId: session.userId,
      sessionId: session.sessionId,
      orgId,
      role,
      expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
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

  // ---- CSRF ------------------------------------------------------------
  //
  // A state-changing request that is authenticated by the session cookie must
  // also echo the readable CSRF cookie back in the `X-CSRF-Token` header. A
  // cross-site page can cause the browser to send the cookie, but it cannot
  // read the cookie value, so it cannot produce a matching header.
  //
  // Requests carrying an `Authorization` header are skipped: they are
  // authenticated by the bearer token alone (the session hook above ignores
  // their cookies), and a browser never attaches that header on its own.
  fastify.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (request.headers.authorization) return;

    // Login and registration: a browser always sends Origin on a
    // cross-origin POST, so a foreign Origin is a forged form or fetch
    // (login CSRF). Non-browser clients send no Origin and are allowed.
    if (SESSION_START_ROUTES.has(pathOf(request))) {
      const origin = request.headers.origin;
      if (origin && !config.WEB_ORIGIN.includes(origin)) {
        await reply
          .code(403)
          .send({ error: 'csrf_failed', message: 'Request origin is not allowed' });
      }
      return;
    }

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
