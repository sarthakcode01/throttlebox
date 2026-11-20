import { expect } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildServer } from '../../src/index.js';
import { db } from '../../src/db/client.js';
import { orgMembers, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { destroyTestOrg, type TestOrg } from '../keys/helpers.js';

export interface TestApp {
  app: FastifyInstance;
  server: FastifyInstance['server'];
  orgs: TestOrg[];
  close(): Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const app = await buildServer();
  await app.ready();
  const orgs: TestOrg[] = [];
  return {
    app,
    server: app.server,
    orgs,
    async close() {
      await app.close();
      for (const org of orgs) await destroyTestOrg(org);
    },
  };
}

export interface Client {
  userId: string;
  orgId: string;
  email: string;
  csrf: string;
  get(url: string): request.Test;
  post(url: string): request.Test;
  put(url: string): request.Test;
  patch(url: string): request.Test;
  delete(url: string): request.Test;
}

export function cookieValue(setCookie: unknown, name: string): string {
  const list = (setCookie ?? []) as string[];
  const entry = list.find((c) => c.startsWith(`${name}=`));
  return entry?.split(';')[0]?.split('=')[1] ?? '';
}

function wrap(
  agent: ReturnType<typeof request.agent>,
  csrf: string,
  base: Pick<Client, 'userId' | 'orgId' | 'email'>,
): Client {
  const h = () => ({ 'X-CSRF-Token': csrf });
  return {
    ...base,
    csrf,
    get: (url) => agent.get(url),
    post: (url) => agent.post(url).set(h()),
    put: (url) => agent.put(url).set(h()),
    patch: (url) => agent.patch(url).set(h()),
    delete: (url) => agent.delete(url).set(h()),
  };
}

/** Register through the real endpoint and return a signed-in client. */
export async function signUp(t: TestApp, label: string): Promise<Client> {
  const agent = request.agent(t.server);
  const email = `tb-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const res = await agent
    .post('/api/auth/register')
    .send({ email, password: 'a-long-enough-password', name: 'Test Person' });
  expect(res.status).toBe(201);
  t.orgs.push({ userId: res.body.user.id, orgId: res.body.org.id });
  const csrf = cookieValue(res.headers['set-cookie'], 'throttlebox_csrf');
  return wrap(agent, csrf, { userId: res.body.user.id, orgId: res.body.org.id, email });
}

/** Add a member with a given role to an existing org and sign them in. */
export async function signInAsMember(
  t: TestApp,
  orgId: string,
  role: 'admin' | 'dev' | 'viewer',
): Promise<Client> {
  const email = `tb-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = 'a-long-enough-password';
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(password), name: `${role} user` })
    .returning({ id: users.id });
  await db.insert(orgMembers).values({ orgId, userId: user!.id, role });

  const agent = request.agent(t.server);
  const res = await agent.post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  const csrf = cookieValue(res.headers['set-cookie'], 'throttlebox_csrf');
  // Members are cleaned up by deleting the user row; org cleanup is owned by the owner.
  afterCleanup.push(async () => {
    await db.delete(orgMembers).where(eq(orgMembers.userId, user!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  });
  return wrap(agent, csrf, { userId: user!.id, orgId, email });
}

const afterCleanup: Array<() => Promise<void>> = [];
export async function runMemberCleanup(): Promise<void> {
  while (afterCleanup.length) await afterCleanup.pop()!();
}

/** Create an API key through the real endpoint. */
export async function createApiKey(
  client: Client,
  opts: { env?: 'test' | 'live'; scopes?: string[]; name?: string } = {},
): Promise<{ id: string; key: string }> {
  const res = await client
    .post('/api/keys')
    .send({
      name: opts.name ?? 'e2e',
      env: opts.env ?? 'test',
      scopes: opts.scopes ?? ['mock:read', 'mock:write'],
    });
  expect(res.status).toBe(201);
  return { id: res.body.id, key: res.body.key };
}
