import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { buildServer } from '../../src/index.js';
import { db } from '../../src/db/client.js';
import { redis } from '../../src/db/redis.js';
import { orgMembers, orgs, users } from '../../src/db/schema.js';
import { hashSessionToken } from '../../src/auth/token.js';
import { createSession, CSRF_COOKIE, SESSION_COOKIE } from '../../src/auth/session.js';
import { safeEqualString } from '../../src/util/crypto.js';
import { createTestOrg, destroyTestOrg } from '../keys/helpers.js';

/**
 * Regression tests for the Phase 1 fixes in PHASE_WISE_BUG_REPORT.md.
 */

function cookieHeader(setCookie: string[] | string | undefined, name: string): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.find((cookie) => cookie.startsWith(`${name}=`));
}

function uniqueEmail(label: string): string {
  return `tb-reg-${label}-${randomUUID()}@example.test`;
}

async function deleteUserByEmail(email: string): Promise<void> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!user) return;
  await db.delete(orgs).where(eq(orgs.ownerId, user.id));
  await db.delete(users).where(eq(users.id, user.id));
}

describe('Phase 1 regressions', () => {
  let app: FastifyInstance;
  let server: Server;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    server = app.server;
  });

  afterAll(async () => {
    await app.close();
    for (const email of createdEmails) await deleteUserByEmail(email);
  });

  async function register(name = 'Ada Lovelace') {
    const email = uniqueEmail('user');
    createdEmails.push(email);
    const response = await request(server)
      .post('/api/auth/register')
      .send({ email, password: 'a-long-enough-password', name });
    return { email, response };
  }

  it('1.1: the CSRF cookie expires with the session, not with the browser', async () => {
    const { response } = await register();
    expect(response.status).toBe(201);

    const session = cookieHeader(response.headers['set-cookie'], SESSION_COOKIE);
    const csrf = cookieHeader(response.headers['set-cookie'], CSRF_COOKIE);
    expect(session).toMatch(/Expires=/);
    expect(csrf).toMatch(/Expires=/);
  });

  it('1.1: /me re-issues a CSRF cookie to a session that lost it', async () => {
    const { response } = await register();
    const sessionCookie = cookieHeader(response.headers['set-cookie'], SESSION_COOKIE)!.split(
      ';',
    )[0];

    const me = await request(server).get('/api/me').set('Cookie', sessionCookie!);
    expect(me.status).toBe(200);
    expect(cookieHeader(me.headers['set-cookie'], CSRF_COOKIE)).toBeDefined();
  });

  it('1.1: login works with a stale session cookie and no CSRF cookie', async () => {
    const { email, response } = await register();
    const sessionCookie = cookieHeader(response.headers['set-cookie'], SESSION_COOKIE)!.split(
      ';',
    )[0];

    const login = await request(server)
      .post('/api/auth/login')
      .set('Cookie', sessionCookie!)
      .send({ email, password: 'a-long-enough-password' });
    expect(login.status).toBe(200);
  });

  it('1.2: a session past its absolute expiry is rejected even while Redis still holds it', async () => {
    const org = await createTestOrg('expiry');
    try {
      const session = await createSession({ userId: org.userId });
      const key = `session:${hashSessionToken(session.token)}`;
      const record = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
      await redis.set(key, JSON.stringify({ ...record, expiresAt: Date.now() - 1000 }), 'EX', 3600);

      const me = await request(server)
        .get('/api/me')
        .set('Cookie', `${SESSION_COOKIE}=${session.token}`);
      expect(me.status).toBe(401);
    } finally {
      await destroyTestOrg(org);
    }
  });

  it('1.3: logout clears both cookies', async () => {
    const { response } = await register();
    const cookies = (response.headers['set-cookie'] as unknown as string[]).map(
      (c) => c.split(';')[0],
    );
    const csrf = cookies.find((c) => c!.startsWith(`${CSRF_COOKIE}=`))!.split('=')[1]!;

    const logout = await request(server)
      .post('/api/auth/logout')
      .set('Cookie', cookies.join('; '))
      .set('X-CSRF-Token', csrf);
    expect(logout.status).toBe(200);
    expect(cookieHeader(logout.headers['set-cookie'], SESSION_COOKIE)).toMatch(
      /Expires=Thu, 01 Jan 1970/,
    );
    expect(cookieHeader(logout.headers['set-cookie'], CSRF_COOKIE)).toMatch(
      /Expires=Thu, 01 Jan 1970/,
    );
  });

  it('1.4 / H3: a demoted member loses permissions once the cached role is revalidated', async () => {
    const org = await createTestOrg('demote');
    try {
      const session = await createSession({ userId: org.userId, orgId: org.orgId, role: 'owner' });
      const headers = {
        Cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrfToken}`,
        'X-CSRF-Token': session.csrfToken,
      };

      await db
        .update(orgMembers)
        .set({ role: 'viewer' })
        .where(and(eq(orgMembers.orgId, org.orgId), eq(orgMembers.userId, org.userId)));

      // Age the cached membership past the revalidation interval.
      const key = `session:${hashSessionToken(session.token)}`;
      const record = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
      await redis.set(key, JSON.stringify({ ...record, membershipCheckedAt: 0 }), 'EX', 3600);

      const create = await request(server)
        .post('/api/keys')
        .set(headers)
        .send({ name: 'should-fail', env: 'test' });
      expect(create.status).toBe(403);
    } finally {
      await destroyTestOrg(org);
    }
  });

  it('1.6: two concurrent registrations for one email give 201 and 409, never 500', async () => {
    const email = uniqueEmail('race');
    createdEmails.push(email);
    const body = { email, password: 'a-long-enough-password', name: 'Racer' };

    const results = await Promise.all([
      request(server).post('/api/auth/register').send(body),
      request(server).post('/api/auth/register').send(body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('1.8: the workspace is named after the trimmed first name', async () => {
    const { response } = await register('   Grace   Hopper ');
    expect(response.status).toBe(201);
    expect(response.body.org.name).toBe("Grace's Workspace");
    expect(response.body.user.name).toBe('Grace   Hopper');
  });

  it('1.8: a whitespace-only name is rejected', async () => {
    const { response } = await register('    ');
    expect(response.status).toBe(400);
  });

  it('M10: passwords shorter than 12 characters are rejected', async () => {
    const email = uniqueEmail('short');
    const response = await request(server)
      .post('/api/auth/register')
      .send({ email, password: 'elevenchars', name: 'Short' });
    expect(response.status).toBe(400);
  });

  it('1.9: a request with a bearer token is not authenticated by its cookie', async () => {
    const { response } = await register();
    const sessionCookie = cookieHeader(response.headers['set-cookie'], SESSION_COOKIE)!.split(
      ';',
    )[0];

    const me = await request(server)
      .get('/api/me')
      .set('Cookie', sessionCookie!)
      .set('Authorization', 'Bearer not-a-real-key');
    expect(me.status).toBe(401);
  });

  it('1.10: login from a foreign Origin is refused', async () => {
    const response = await request(server)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: uniqueEmail('x'), password: 'whatever-password' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('csrf_failed');
  });

  it('L15: sign out everywhere destroys every session for the user', async () => {
    const org = await createTestOrg('logout-all');
    try {
      const first = await createSession({ userId: org.userId });
      const second = await createSession({ userId: org.userId });

      const response = await request(server)
        .post('/api/auth/logout-all')
        .set('Cookie', `${SESSION_COOKIE}=${first.token}; ${CSRF_COOKIE}=${first.csrfToken}`)
        .set('X-CSRF-Token', first.csrfToken);
      expect(response.status).toBe(200);

      const me = await request(server)
        .get('/api/me')
        .set('Cookie', `${SESSION_COOKIE}=${second.token}`);
      expect(me.status).toBe(401);
    } finally {
      await destroyTestOrg(org);
    }
  });

  it('M11: safeEqualString still compares correctly', () => {
    expect(safeEqualString('abc', 'abc')).toBe(true);
    expect(safeEqualString('abc', 'abd')).toBe(false);
    expect(safeEqualString('abc', 'abcd')).toBe(false);
    expect(safeEqualString('', '')).toBe(false);
  });

  it('0.9: the health probe reports the package version', async () => {
    const response = await request(server).get('/health');
    expect(response.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
