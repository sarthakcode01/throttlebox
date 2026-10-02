import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { orgMembers, orgs, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, destroySession, CSRF_COOKIE, SESSION_COOKIE } from '../auth/session.js';
import { config, isProduction } from '../config.js';

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(200),
  name: z.string().min(1).max(120),
});

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
  domain: isProduction ? config.COOKIE_DOMAIN : undefined,
} as const;

/**
 * A pre-computed Argon2id hash of a random string. Verifying against it when
 * no user is found keeps the login timing profile flat, so response time
 * doesn't reveal whether an email is registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Y2FuYXJ5c2FsdGJhc2U$8Q1Yn0F8B7lKl2Fh2vGzUu0VbY0n1q3Pz8rXk4mY6sJg';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // ---- Register -------------------------------------------------------
  fastify.post('/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid input',
      });
    }
    const { email, password, name } = parsed.data;

    // Reject duplicate emails case-insensitively.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
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
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    reply
      .setCookie(SESSION_COOKIE, session.token, {
        ...cookieOptions,
        expires: session.expiresAt,
      })
      .setCookie(CSRF_COOKIE, session.csrfToken, {
        // Readable by JS on purpose — the client echoes it in X-CSRF-Token.
        httpOnly: false,
        path: '/',
      });

    return reply.code(201).send({ user, org });
  });

  // ---- Login ----------------------------------------------------------
  fastify.post('/auth/login', async (request, reply) => {
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
      .where(eq(users.email, email.toLowerCase()))
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

    const session = await createSession({
      userId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    reply
      .setCookie(SESSION_COOKIE, session.token, {
        ...cookieOptions,
        expires: session.expiresAt,
      })
      .setCookie(CSRF_COOKIE, session.csrfToken, {
        httpOnly: false,
        path: '/',
      });

    return reply.send({ user: { id: user.id, email: user.email, name: user.name } });
  });

  // ---- Logout ---------------------------------------------------------
  fastify.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await destroySession(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.send({ ok: true });
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
