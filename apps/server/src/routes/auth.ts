import { randomBytes } from 'node:crypto';
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
import { seedFlagshipService } from '../mock/seed.js';
import { createRateLimit } from '../http/rateLimit.js';
import { config, isProduction, isTest } from '../config.js';

/**
 * Password policy for anything that sets a password (register, reset).
 *
 * Length does the heavy lifting — a 12-character minimum with no forced
 * character classes is stronger than a shorter password full of symbols, and
 * it does not push users towards predictable substitutions. The blocklist
 * catches the handful of passwords that defeat a length rule on their own.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '1234567890',
  '12345678901',
  '123456789012',
  'qwertyuiop',
  'qwerty12345',
  'letmein12345',
  'welcome12345',
  'admin12345',
  'iloveyou123',
  'changeme123',
  'throttlebox',
]);

const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200)
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'That password is too common');

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: passwordSchema,
  name: z.string().min(1).max(120),
});

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

/**
 * Cookie names.
 *
 * In production the session cookie uses the `__Host-` prefix: the browser will
 * then refuse to accept it from anything but the exact origin, over HTTPS,
 * with no `Domain` attribute — so a compromised sibling subdomain cannot
 * overwrite the session cookie. That also removes the need for COOKIE_DOMAIN,
 * which is why the domain is no longer set on the production cookie.
 */
const SESSION_COOKIE_NAME = isProduction ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
const CSRF_COOKIE_NAME = isProduction ? `__Host-${CSRF_COOKIE}` : CSRF_COOKIE;

const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
} as const;

/**
 * The CSRF cookie is deliberately readable by JavaScript — the client copies
 * it into the `X-CSRF-Token` header on every mutation. It must not be
 * `httpOnly`, but it still gets the same transport attributes as the session
 * cookie.
 */
const csrfCookieOptions = {
  httpOnly: false,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
} as const;

/**
 * The CSRF cookie must outlive the browser session exactly as long as the
 * session cookie does. It previously had no `expires` at all, so after a
 * browser restart the session survived and every mutation 403'd until the
 * user signed in again.
 */
function csrfCookieOptionsFor(expires: Date): typeof csrfCookieOptions & { expires: Date } {
  return { ...csrfCookieOptions, expires };
}

/**
 * A real Argon2id hash of a random string, produced at boot.
 *
 * Verifying against it when no user is found keeps the login timing profile
 * flat, so response time does not reveal whether an email is registered.
 *
 * It must be generated here rather than hard-coded: a hand-written constant
 * with a salt of a different length verifies noticeably faster or slower than
 * a production hash, which turns the equalizer into the oracle it exists to
 * prevent. Generating it with `hashPassword` guarantees identical parameters.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHashPromise;
}

/**
 * Brute-force protection for the credential endpoints.
 *
 * Login is the one place where an unauthenticated caller gets to make the
 * server do expensive work (an Argon2id verification), so it needs a ceiling
 * on how often that can happen. Registration is limited too, because
 * otherwise the endpoint is a free way to fill the database and burn CPU on
 * password hashing.
 *
 * In tests the ceiling is raised rather than removed. Disabling it entirely
 * meant the limiter's wiring was never exercised by an integration test — a
 * regression there would have gone unnoticed by CI. A high ceiling keeps the
 * fixtures running while leaving the code path live.
 */
const authRateLimitMax = isTest ? 10_000 : config.AUTH_RATE_LIMIT_MAX;

const authRateLimiter = createRateLimit({
  max: authRateLimitMax,
  windowMs: config.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
  keyGenerator: (request) => `auth:${request.ip}`,
  prefix: 'ratelimit:auth',
  message: 'Too many attempts. Please wait and try again.',
});

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // ---- Register -------------------------------------------------------
  fastify.post(
    '/auth/register',
    { preHandler: authRateLimiter.handler },
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

      const { user, org } = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({ email: email.toLowerCase(), passwordHash, name })
          .returning({ id: users.id, email: users.email, name: users.name });

        if (!created) throw new Error('Failed to create user');

        // Every new user gets a personal org, so there is always an org context.
        const orgName = `${name.split(' ')[0] ?? name}'s Workspace`;
        const [createdOrg] = await tx
          .insert(orgs)
          .values({ name: orgName, ownerId: created.id })
          .returning({ id: orgs.id, name: orgs.name, plan: orgs.plan });

        if (!createdOrg) throw new Error('Failed to create org');

        await tx.insert(orgMembers).values({
          orgId: createdOrg.id,
          userId: created.id,
          role: 'owner',
        });

        return { user: created, org: createdOrg };
      });

      const session = await createSession({
        userId: user.id,
        orgId: org.id,
        role: 'owner',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      // Every new org starts with the flagship mock service, so there is
      // something to call as soon as the user has a key.
      await seedFlagshipService(org.id);

      reply
        .setCookie(SESSION_COOKIE_NAME, session.token, {
          ...cookieOptions,
          expires: session.expiresAt,
        })
        .setCookie(CSRF_COOKIE_NAME, session.csrfToken, csrfCookieOptionsFor(session.expiresAt));

      return reply.code(201).send({ user, org });
    },
  );

  // ---- Login ----------------------------------------------------------
  fastify.post('/auth/login', { preHandler: authRateLimiter.handler }, async (request, reply) => {
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
    // The dummy hash has the same parameters as a real one, so a miss and a hit
    // cost the same.
    const hash = user?.passwordHash ?? (await dummyHash());
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

    reply
      .setCookie(SESSION_COOKIE_NAME, session.token, {
        ...cookieOptions,
        expires: session.expiresAt,
      })
      .setCookie(CSRF_COOKIE_NAME, session.csrfToken, csrfCookieOptionsFor(session.expiresAt));

    return reply.send({ user: { id: user.id, email: user.email, name: user.name } });
  });

  // ---- Logout ---------------------------------------------------------
  fastify.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) {
      await destroySession(token);
    }
    reply
      .clearCookie(SESSION_COOKIE_NAME, { path: '/' })
      .clearCookie(CSRF_COOKIE_NAME, { path: '/' });
    return reply.send({ ok: true });
  });

  // ---- Password change / sign out everywhere --------------------------
  //
  // Until now the only way out of a session was to log out of it, and
  // `destroyAllSessionsForUser` was unreachable. Both endpoints below are
  // rate limited like the other credential operations: they either verify a
  // password or are the response to a suspected compromise.

  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
  });

  fastify.post(
    '/auth/password',
    { preHandler: [authRateLimiter.handler] },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        return reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
      }

      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid input',
        });
      }

      const [user] = await db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1);
      if (!user) {
        return reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
      }

      if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
        return reply
          .code(403)
          .send({ error: 'invalid_password', message: 'Current password is incorrect' });
      }

      await db
        .update(users)
        .set({ passwordHash: await hashPassword(parsed.data.newPassword) })
        .where(eq(users.id, user.id));

      // Every other session is now suspect, including the one that made the
      // request: changing a password must end all of them, so the client is
      // signed out and has to authenticate with the new password.
      await destroyAllSessionsForUser(user.id);

      return reply
        .clearCookie(SESSION_COOKIE_NAME, { path: '/' })
        .clearCookie(CSRF_COOKIE_NAME, { path: '/' })
        .send({ ok: true, message: 'Password changed. Sign in again with the new password.' });
    },
  );

  fastify.post('/auth/sessions/revoke-all', async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
    }

    const revoked = await destroyAllSessionsForUser(auth.userId);

    return reply
      .clearCookie(SESSION_COOKIE_NAME, { path: '/' })
      .clearCookie(CSRF_COOKIE_NAME, { path: '/' })
      .send({ ok: true, revoked });
  });

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
