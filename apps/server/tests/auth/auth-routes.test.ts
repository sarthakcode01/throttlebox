import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cookieValue,
  runMemberCleanup,
  signInAsMember,
  signUp,
  startApp,
  type TestApp,
} from '../helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
  await runMemberCleanup();
});

const PASSWORD = 'a-long-enough-password';

describe('POST /api/auth/register', () => {
  it('creates a user, a personal org with the owner role, and sets both cookies', async () => {
    const email = `tb-reg-${Date.now()}@example.test`;
    const res = await request(t.server)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, name: 'Ada Lovelace' });

    expect(res.status).toBe(201);
    t.orgs.push({ userId: res.body.user.id, orgId: res.body.org.id });
    expect(res.body.user.email).toBe(email);
    expect(res.body.org.name).toBe("Ada's Workspace");
    expect(res.body.org.plan).toBe('free');
    expect(res.body.user).not.toHaveProperty('passwordHash');

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('throttlebox_session='))!;
    const csrf = cookies.find((c) => c.startsWith('throttlebox_csrf='))!;
    expect(session).toMatch(/HttpOnly/i);
    // The CSRF cookie must be readable by JS.
    expect(csrf).not.toMatch(/HttpOnly/i);
  });

  it.each([
    ['invalid email', { email: 'nope', password: PASSWORD, name: 'X' }],
    ['short password', { email: 'a@example.test', password: 'short', name: 'X' }],
    ['missing name', { email: 'a@example.test', password: PASSWORD }],
    ['empty body', {}],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await request(t.server).post('/api/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects a duplicate email case-insensitively with 409', async () => {
    const client = await signUp(t, 'dup');
    const res = await request(t.server)
      .post('/api/auth/register')
      .send({ email: client.email.toUpperCase(), password: PASSWORD, name: 'Again' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_taken');
  });

  it('seeds the flagship ecommerce service for the new org', async () => {
    const client = await signUp(t, 'seed');
    const res = await client.get('/api/mock/services');
    expect(res.status).toBe(200);
    expect(res.body.services.map((s: { slug: string }) => s.slug)).toContain('ecommerce');
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with valid credentials (email is case-insensitive) and issues a working session', async () => {
    const owner = await signUp(t, 'login');
    const agent = request.agent(t.server);
    const res = await agent
      .post('/api/auth/login')
      .send({ email: owner.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(owner.email);

    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('owner');
    expect(me.body.org.id).toBe(owner.orgId);
  });

  it('returns the same 401 for a wrong password and an unknown email', async () => {
    const owner = await signUp(t, 'badlogin');
    const wrong = await request(t.server)
      .post('/api/auth/login')
      .send({ email: owner.email, password: 'definitely-wrong-pass' });
    const unknown = await request(t.server)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.test', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('rejects malformed bodies with 400', async () => {
    const res = await request(t.server).post('/api/auth/login').send({ email: 'x' });
    expect(res.status).toBe(400);
  });

  it('replaces the previous session when signing in while already signed in', async () => {
    const owner = await signUp(t, 'resession');
    const agent = request.agent(t.server);
    const first = await agent
      .post('/api/auth/login')
      .send({ email: owner.email, password: PASSWORD });
    const oldToken = cookieValue(first.headers['set-cookie'], 'throttlebox_session');
    const csrf = cookieValue(first.headers['set-cookie'], 'throttlebox_csrf');
    // A request that carries a session cookie is CSRF-protected, login included.
    const second = await agent
      .post('/api/auth/login')
      .set('X-CSRF-Token', csrf)
      .send({ email: owner.email, password: PASSWORD });
    expect(second.status).toBe(200);
    const stale = await request(t.server)
      .get('/api/me')
      .set('Cookie', `throttlebox_session=${oldToken}`);
    expect(stale.status).toBe(401);
  });
});

describe('login while holding a session cookie', () => {
  it('is CSRF-protected: a login carrying a session cookie but no token is rejected', async () => {
    const owner = await signUp(t, 'logincsrf');
    const agent = request.agent(t.server);
    await agent.post('/api/auth/login').send({ email: owner.email, password: PASSWORD });
    const res = await agent
      .post('/api/auth/login')
      .send({ email: owner.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_failed');
  });
});

describe('sessions, /me and logout', () => {
  it('rejects /me without a session and with a forged cookie', async () => {
    expect((await request(t.server).get('/api/me')).status).toBe(401);
    const forged = await request(t.server)
      .get('/api/me')
      .set('Cookie', 'throttlebox_session=' + 'a'.repeat(64));
    expect(forged.status).toBe(401);
  });

  it('logout invalidates the session server-side', async () => {
    const owner = await signUp(t, 'logout');
    expect((await owner.get('/api/me')).status).toBe(200);
    const out = await owner.post('/api/auth/logout');
    expect(out.status).toBe(200);
    expect((await owner.get('/api/me')).status).toBe(401);
  });
});

describe('CSRF double-submit', () => {
  it('blocks a cookie-authenticated mutation with no CSRF header', async () => {
    const owner = await signUp(t, 'csrf1');
    const agent = request.agent(t.server);
    await agent.post('/api/auth/login').send({ email: owner.email, password: PASSWORD });
    const res = await agent.post('/api/keys').send({ name: 'x', env: 'test' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_failed');
  });

  it('blocks a mutation with a mismatched CSRF header', async () => {
    const owner = await signUp(t, 'csrf2');
    const res = await owner
      .post('/api/keys')
      .set('X-CSRF-Token', 'wrong')
      .send({ name: 'x', env: 'test' });
    expect(res.status).toBe(403);
  });

  it('allows the mutation with the matching header', async () => {
    const owner = await signUp(t, 'csrf3');
    const res = await owner.post('/api/keys').send({ name: 'x', env: 'test' });
    expect(res.status).toBe(201);
  });

  it('does not require CSRF for safe methods', async () => {
    const owner = await signUp(t, 'csrf4');
    expect((await owner.get('/api/keys')).status).toBe(200);
  });
});

describe('RBAC on the org plan', () => {
  it('lets the owner read and change the plan, effective immediately', async () => {
    const owner = await signUp(t, 'plan');
    const before = await owner.get('/api/org/plan');
    expect(before.status).toBe(200);
    expect(before.body.plan.id).toBe('free');
    expect(before.body.plan.requestsPerWindow).toBe(100);

    const upd = await owner.patch('/api/org/plan').send({ plan: 'pro' });
    expect(upd.status).toBe(200);
    const after = await owner.get('/api/org/plan');
    expect(after.body.plan.id).toBe('pro');
    expect(after.body.plan.requestsPerWindow).toBe(5000);
  });

  it('rejects an unknown plan with 400', async () => {
    const owner = await signUp(t, 'plan400');
    const res = await owner.patch('/api/org/plan').send({ plan: 'enterprise' });
    expect(res.status).toBe(400);
  });

  it('forbids dev and viewer from changing the plan, lets them read it, and allows admin', async () => {
    const owner = await signUp(t, 'planrbac');
    const dev = await signInAsMember(t, owner.orgId, 'dev');
    const viewer = await signInAsMember(t, owner.orgId, 'viewer');
    const admin = await signInAsMember(t, owner.orgId, 'admin');

    expect((await dev.patch('/api/org/plan').send({ plan: 'pro' })).status).toBe(403);
    expect((await viewer.patch('/api/org/plan').send({ plan: 'pro' })).status).toBe(403);
    expect((await viewer.get('/api/org/plan')).status).toBe(200);
    expect((await admin.patch('/api/org/plan').send({ plan: 'pro' })).status).toBe(200);
  });

  it('requires authentication', async () => {
    expect((await request(t.server).get('/api/org/plan')).status).toBe(401);
  });
});
