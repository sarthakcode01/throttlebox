import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { orgMembers, orgs, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  createSession,
  destroyAllSessionsForUser,
  destroySession,
  CSRF_COOKIE,
  SESSION_COOKIE,
} from '../auth/session.js';
import {
  clearAuthCookies,
  reissueCsrfCookie,
  setCsrfCookie,
  setSessionCookie,
} from '../auth/cookies.js';
import { seedFlagshipService } from '../mock/seed.js';
import { createRateLimit } from '../http/rateLimit.js';
import { config, isTest } from '../config.js';

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

export const MIN_PASSWORD_LENGTH = 12;

const registerSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(200),
  name: z.string().trim().min(1, 'Name is required').max(120),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
});

/**
 * A pre-computed Argon2id hash of a random string. Verifying against it when
 * no user is found keeps the login timing profile flat, so response time
 * doesn't reveal whether an email is registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Y2FuYXJ5c2FsdGJhc2U$8Q1Yn0F8B7lKl2Fh2vGzUu0VbY0n1q3Pz8rXk4mY6sJg';

/**
 * Brute-force protection for the credential endpoints.
 *
 * Login is the one place where an unauthenticated caller gets to make the
 * server do expensive work (an Argon2id verification), so it needs a ceiling
 * on how often that can happen. Registration is limited too, because
 * otherwise the endpoint is a free way to fill the database and burn CPU on
 * password hashing.
 *
 * The limit is disabled under NODE_ENV=test so the suite is not throttled by
 * its own fixtures; the limiter itself is covered by a dedicated test.
 */
function authLimiter(action: 'login' | 'register') {
  // Separate budgets, so a burst of sign-ups from a shared office address
  // does not lock everyone out of signing in.
  return createRateLimit({
    max: config.AUTH_RATE_LIMIT_MAX,
    windowMs: config.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
    keyGenerator: (request) => `auth:${action}:${request.ip}`,
    enabled: !isTest,
    message: 'Too many attempts. Please wait and try again.',
  });
}

const loginRateLimiter = authLimiter('login');
const registerRateLimiter = authLimiter('register');

/** Surfaced by the error handler as a 409, the same answer as the pre-check. */
class EmailTakenError extends Error {
  statusCode = 409;
  code = 'email_taken';
  constructor() {
    super('That email is already registered');
  }
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // ---- Register -------------------------------------------------------
  fastify.post(
    '/auth/register',
    { preHandler: registerRateLimiter.handler },
    async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid input',
        });
      }
      const { email, password, name } = parsed.data;

      // Reject duplicate emails case-insensitively.
      //
      // The comparison uses `lower(email)` so it can use the `users_email_lower`
      // unique index. A plain `email = $1` cannot use that index — the planner
      // has no way to know the column is already lowercased — and falls back to
      // a sequential scan of the whole table on every registration.
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
        .limit(1);
      if (existing.length > 0) {
        return reply
          .code(409)
          .send({ error: 'email_taken', message: 'That email is already registered' });
      }

      const passwordHash = await hashPassword(password);

      let created: {
        user: { id: string; email: string; name: string };
        org: { id: string; name: string; plan: 'free' | 'pro' };
      };

      try {
        created = await db.transaction(async (tx) => {
          const [user] = await tx
            .insert(users)
            .values({ email: email.toLowerCase(), passwordHash, name })
            .returning({ id: users.id, email: users.email, name: users.name });

          if (!user) throw new Error('Failed to create user');

          // Every new user gets a personal org, so there is always an org context.
          const firstName = name.split(/\s+/)[0] || name;
          const [org] = await tx
            .insert(orgs)
            .values({ name: `${firstName}'s Workspace`, ownerId: user.id })
            .returning({ id: orgs.id, name: orgs.name, plan: orgs.plan });

          if (!org) throw new Error('Failed to create org');

          await tx.insert(orgMembers).values({
            orgId: org.id,
            userId: user.id,
            role: 'owner',
          });

          // Every new org starts with the flagship mock service, so there is
          // something to call as soon as the user has a key. Seeding inside
          // the transaction means a failure here rolls the whole account
          // back, instead of leaving a user who can neither finish signing
          // up nor register again.
          await seedFlagshipService(org.id, tx);

          return { user, org };
        });
      } catch (err) {
        // Two registrations for the same address raced past the check above.
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new EmailTakenError();
        }
        throw err;
      }

      const { user, org } = created;

      const session = await createSession({
        userId: user.id,
        orgId: org.id,
        role: 'owner',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      setSessionCookie(reply, session.token, session.expiresAt);
      setCsrfCookie(reply, session.csrfToken, session.expiresAt);

      return reply.code(201).send({ user, org });
    },
  );

  // ---- Login ----------------------------------------------------------
  fastify.post('/auth/login', { preHandler: loginRateLimiter.handler }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'validation_error', message: 'Invalid email or password' });
    }
    const { email, password } = parsed.data;

    const [user] = await db
      .select()
      .from(users)
      // `lower(email)` so the `users_email_lower` index is used — a plain
      // `email = $1` forces a sequential scan.
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);

    // Always run a verify to avoid leaking whether the email exists via timing.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const valid = await verifyPassword(password, hash);

    if (!user || !valid) {
      return reply
        .code(401)
        .send({ error: 'invalid_credentials', message: 'Invalid email or password' });
    }

    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

    // Signing in while already signed in would leave the previous session
    // alive and usable. Destroy it so one login means one live session.
    const previousToken = request.cookies[SESSION_COOKIE];
    if (previousToken) {
      await destroySession(previousToken);
    }

    // Resolve user's default org membership so it is cached inside the Redis session
    const [membership] = await db
      .select({ orgId: orgMembers.orgId, role: orgMembers.role })
      .from(orgMembers)
      .where(eq(orgMembers.userId, user.id))
      .orderBy(orgMembers.createdAt)
      .limit(1);

    const session = await createSession({
      userId: user.id,
      orgId: membership?.orgId ?? null,
      role: membership?.role ?? null,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    setSessionCookie(reply, session.token, session.expiresAt);
    setCsrfCookie(reply, session.csrfToken, session.expiresAt);

    return reply.send({ user: { id: user.id, email: user.email, name: user.name } });
  });

  // ---- Logout ---------------------------------------------------------
  fastify.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await destroySession(token);
    }
    clearAuthCookies(reply);
    return reply.send({ ok: true });
  });

  // ---- Sign out everywhere ---------------------------------------------
  fastify.post(
    '/auth/logout-all',
    { preHandler: [fastify.requireAuth] },
    async (request, reply) => {
      await destroyAllSessionsForUser(request.auth!.userId);
      clearAuthCookies(reply);
      return reply.send({ ok: true });
    },
  );

  // ---- Current session -----------------------------------------------
  fastify.get('/me', async (request, reply) => {
    if (!request.auth) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Not signed in' });
    }
    const [user] = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, request.auth.userId))
      .limit(1);
    if (!user) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Not signed in' });
    }

    // A session whose CSRF cookie has gone missing (cleared, or issued
    // before the cookie carried an expiry) gets a fresh one, so the user is
    // never stuck with a session they cannot make a single mutation with.
    if (!request.cookies[CSRF_COOKIE]) {
      reissueCsrfCookie(reply, request.auth.expiresAt ?? undefined);
    }

    let org = null;
    if (request.auth.orgId) {
      const [row] = await db
        .select({ id: orgs.id, name: orgs.name, plan: orgs.plan })
        .from(orgs)
        .where(eq(orgs.id, request.auth.orgId))
        .limit(1);
      org = row ?? null;
    }

    return reply.send({ user, org, role: request.auth.role });
  });
};
