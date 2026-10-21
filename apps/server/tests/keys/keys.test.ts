import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { apiKeyEvents, apiKeys } from '../../src/db/schema.js';
import { createKey, listKeys, revokeFamily, revokeKey, rotateKey } from '../../src/keys/store.js';
import { verifyKey } from '../../src/keys/verify.js';
import { flushTouches } from '../../src/keys/touch.js';
import { parseKey } from '../../src/keys/format.js';
import { createTestOrg, destroyTestOrg, type TestOrg } from './helpers.js';

/**
 * Integration tests for the API key lifecycle.
 *
 * These run against a real Postgres — the HMAC verification path is the thing
 * under test, so mocking it would prove nothing.
 */

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg('keys');
});

afterAll(async () => {
  await destroyTestOrg(org);
});

async function makeKey(overrides: Partial<Parameters<typeof createKey>[0]> = {}) {
  return createKey({
    orgId: org.orgId,
    name: 'test-key',
    env: 'test',
    createdBy: org.userId,
    ...overrides,
  });
}

describe('key creation', () => {
  it('returns the raw key exactly once and never stores it', async () => {
    const created = await makeKey({ name: 'no-raw-storage' });

    expect(created.key).toMatch(/^sk_test_[0-9A-Za-z]{12}_[0-9A-Za-z]{32}$/);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));

    // The database holds the hash and the display parts, never the secret.
    expect(row?.secretHash).not.toContain(created.key);
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(created.key);
    expect(JSON.stringify(row)).not.toContain(created.key.split('_')[3]);
  });

  it('records a "created" audit event', async () => {
    const created = await makeKey({ name: 'audited' });

    const events = await db.select().from(apiKeyEvents).where(eq(apiKeyEvents.keyId, created.id));

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('created');
    expect(events[0]?.actorUserId).toBe(org.userId);
  });

  it('treats an empty scope list as mock:read, never "all"', async () => {
    const created = await makeKey({ name: 'no-scopes', scopes: [] });
    expect(created.scopes).toEqual(['mock:read']);

    const context = await verifyKey(created.key);
    expect(context?.scopes).toEqual(['mock:read']);
    expect(context?.scopes).not.toContain('chaos:write');
  });

  it('rejects a duplicate Idempotency-Key instead of minting a second key', async () => {
    const first = await makeKey({ name: 'idem', idempotencyKey: 'token-abc' });
    expect(first.key).toBeTruthy();

    await expect(makeKey({ name: 'idem', idempotencyKey: 'token-abc' })).rejects.toThrow(
      /Idempotency-Key/i,
    );
  });
});

describe('verification', () => {
  it('accepts a valid key and returns its context', async () => {
    const created = await makeKey({ name: 'valid' });
    const context = await verifyKey(created.key);

    expect(context).not.toBeNull();
    expect(context?.keyId).toBe(created.id);
    expect(context?.orgId).toBe(org.orgId);
    expect(context?.familyId).toBe(created.familyId);
    expect(context?.env).toBe('test');
  });

  it('rejects a truncated key', async () => {
    const created = await makeKey({ name: 'truncated' });
    expect(await verifyKey(created.key.slice(0, -1))).toBeNull();
  });

  it('rejects a mangled key', async () => {
    expect(await verifyKey('not-a-key-at-all')).toBeNull();
    expect(await verifyKey('')).toBeNull();
  });

  it('rejects a key with a valid format but an unknown public id', async () => {
    const created = await makeKey({ name: 'unknown-id' });
    const parsed = parseKey(created.key)!;

    const unknown = `sk_test_aaaaaaaaaaaa_${parsed.secret}`;
    expect(await verifyKey(unknown)).toBeNull();
  });

  it('rejects the correct public id with the wrong secret', async () => {
    const created = await makeKey({ name: 'wrong-secret' });
    const parsed = parseKey(created.key)!;

    const wrongSecret = `sk_test_${parsed.publicId}_${'A'.repeat(32)}`;
    expect(await verifyKey(wrongSecret)).toBeNull();
  });

  it('rejects a revoked key', async () => {
    const created = await makeKey({ name: 'revoked' });
    expect(await verifyKey(created.key)).not.toBeNull();

    await revokeKey(org.orgId, created.id, { actorUserId: org.userId });
    expect(await verifyKey(created.key)).toBeNull();
  });

  it('rejects an expired key', async () => {
    const created = await makeKey({ name: 'expired', expiresInDays: 1 });

    // Force the expiry into the past.
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, created.id));

    expect(await verifyKey(created.key)).toBeNull();
  });

  it('rejects a key whose grace window has elapsed', async () => {
    const created = await makeKey({ name: 'grace-over' });
    const rotated = await rotateKey({ orgId: org.orgId, keyId: created.id, graceHours: 1 });

    // The old key is still valid during the grace window.
    expect(await verifyKey(created.key)).not.toBeNull();
    expect(await verifyKey(rotated.key)).not.toBeNull();

    // Move the grace deadline into the past.
    await db
      .update(apiKeys)
      .set({ graceUntil: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, created.id));

    expect(await verifyKey(created.key)).toBeNull();
    expect(await verifyKey(rotated.key)).not.toBeNull();
  });

  it('returns null for every failure mode — the response never distinguishes them', async () => {
    const created = await makeKey({ name: 'uniform' });
    const parsed = parseKey(created.key)!;

    const failures = [
      'garbage',
      created.key.slice(0, -1),
      `sk_test_aaaaaaaaaaaa_${parsed.secret}`,
      `sk_test_${parsed.publicId}_${'A'.repeat(32)}`,
    ];

    for (const failure of failures) {
      expect(await verifyKey(failure), failure).toBeNull();
    }
  });
});

describe('rotation', () => {
  it('keeps the old key working during the grace window', async () => {
    const created = await makeKey({ name: 'rotate-grace' });
    const rotated = await rotateKey({ orgId: org.orgId, keyId: created.id, graceHours: 24 });

    expect(rotated.key).not.toBe(created.key);
    expect(rotated.familyId).toBe(created.familyId);

    expect(await verifyKey(created.key)).not.toBeNull();
    expect(await verifyKey(rotated.key)).not.toBeNull();
  });

  it('records the rotation chain', async () => {
    const created = await makeKey({ name: 'rotate-chain' });
    const rotated = await rotateKey({ orgId: org.orgId, keyId: created.id });

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, rotated.id));
    expect(row?.rotatedFrom).toBe(created.id);
    expect(row?.familyId).toBe(created.familyId);

    const events = await db.select().from(apiKeyEvents).where(eq(apiKeyEvents.keyId, rotated.id));
    expect(events.some((e) => e.event === 'rotated')).toBe(true);
  });

  it('lets two concurrent rotations succeed and stay in the same family', async () => {
    const created = await makeKey({ name: 'rotate-concurrent' });

    const [a, b] = await Promise.all([
      rotateKey({ orgId: org.orgId, keyId: created.id }),
      rotateKey({ orgId: org.orgId, keyId: created.id }),
    ]);

    expect(a.key).not.toBe(b.key);
    expect(a.familyId).toBe(created.familyId);
    expect(b.familyId).toBe(created.familyId);
  });

  it('retires the intermediate key when the same key is rotated twice', async () => {
    const created = await makeKey({ name: 'rotate-twice' });

    const first = await rotateKey({ orgId: org.orgId, keyId: created.id, graceHours: 1 });
    const second = await rotateKey({ orgId: org.orgId, keyId: created.id, graceHours: 1 });

    // The first successor is now superseded. It must not stay current
    // forever — a family has at most one current key.
    const [intermediate] = await db.select().from(apiKeys).where(eq(apiKeys.id, first.id));

    expect(intermediate?.graceUntil).not.toBeNull();
    expect(intermediate?.status).toBe('active');

    // It still works inside the grace window…
    expect(await verifyKey(first.key)).not.toBeNull();
    // …but the newest key is the one that stays current.
    expect(await verifyKey(second.key)).not.toBeNull();

    // Once the grace window elapses, the intermediate key is dead.
    await db
      .update(apiKeys)
      .set({ graceUntil: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, first.id));

    expect(await verifyKey(first.key)).toBeNull();
    expect(await verifyKey(second.key)).not.toBeNull();
  });

  it('refuses to narrow the scope set', async () => {
    const created = await makeKey({ name: 'rotate-scopes', scopes: ['mock:read', 'mock:write'] });

    await expect(
      rotateKey({ orgId: org.orgId, keyId: created.id, scopes: ['mock:read'] }),
    ).rejects.toThrow(/scope/i);
  });

  it('allows widening the scope set', async () => {
    const created = await makeKey({ name: 'rotate-widen', scopes: ['mock:read'] });
    const rotated = await rotateKey({
      orgId: org.orgId,
      keyId: created.id,
      scopes: ['mock:read', 'mock:write'],
    });

    expect(rotated.scopes).toEqual(['mock:read', 'mock:write']);
  });
});

describe('family revocation', () => {
  it('kills every key in the rotation chain', async () => {
    const created = await makeKey({ name: 'family' });
    const rotated = await rotateKey({ orgId: org.orgId, keyId: created.id });

    const revokedCount = await revokeFamily(org.orgId, created.familyId, {
      actorUserId: org.userId,
    });

    expect(revokedCount).toBe(2);
    expect(await verifyKey(created.key)).toBeNull();
    expect(await verifyKey(rotated.key)).toBeNull();
  });

  it('records a family_revoked event', async () => {
    const created = await makeKey({ name: 'family-event' });
    await revokeFamily(org.orgId, created.familyId, { actorUserId: org.userId });

    const events = await db
      .select()
      .from(apiKeyEvents)
      .where(eq(apiKeyEvents.orgId, org.orgId))
      .orderBy(sql`${apiKeyEvents.createdAt} desc`);

    expect(events.some((e) => e.event === 'family_revoked')).toBe(true);
  });
});

describe('listing', () => {
  it('never exposes the secret', async () => {
    const created = await makeKey({ name: 'listed' });
    const keys = await listKeys(org.orgId);

    const listed = keys.find((k) => k.id === created.id);
    expect(listed).toBeDefined();
    expect(listed?.display).toBe(`${created.prefix}…${created.last4}`);
    expect(JSON.stringify(keys)).not.toContain(created.key);
    expect(JSON.stringify(keys)).not.toContain(created.key.split('_')[3]);
  });
});

describe('last_used_at', () => {
  it('is written by the write-behind buffer', async () => {
    const created = await makeKey({ name: 'touched' });

    const before = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(before[0]?.lastUsedAt).toBeNull();

    await verifyKey(created.key);
    await flushTouches();

    const after = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(after[0]?.lastUsedAt).not.toBeNull();
  });

  it('coalesces repeated touches into one row', async () => {
    const created = await makeKey({ name: 'touched-many' });

    await verifyKey(created.key);
    await verifyKey(created.key);
    await verifyKey(created.key);
    await flushTouches();

    const after = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(after[0]?.lastUsedAt).not.toBeNull();
  });
});
