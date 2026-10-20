import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { apiKeyEvents, orgMembers, orgs, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';

export interface TestOrg {
  userId: string;
  orgId: string;
}

/**
 * Create a throwaway user + org + membership.
 *
 * The org id is the cleanup handle: deleting it cascades to `api_keys` and
 * `api_key_families`.
 */
export async function createTestOrg(label: string): Promise<TestOrg> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const email = `tb-${label}-${unique}@example.test`;

  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword('correct horse battery staple'),
      name: 'Test User',
    })
    .returning({ id: users.id });

  if (!user) throw new Error('Failed to create test user');

  const [org] = await db
    .insert(orgs)
    .values({ name: `Test Org ${label}`, ownerId: user.id })
    .returning({ id: orgs.id });

  if (!org) throw new Error('Failed to create test org');

  await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: 'owner' });

  return { userId: user.id, orgId: org.id };
}

/**
 * Remove a test org and everything attached to it.
 *
 * `api_key_events.org_id` is intentionally not a foreign key, so the audit
 * trail is cleaned up explicitly rather than by cascade.
 */
export async function destroyTestOrg(org: TestOrg): Promise<void> {
  await db.delete(apiKeyEvents).where(eq(apiKeyEvents.orgId, org.orgId));
  await db.delete(orgs).where(eq(orgs.id, org.orgId));
  await db.delete(users).where(eq(users.id, org.userId));
}
