import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  getCachedKey,
  invalidateCachedKey,
  invalidateCachedKeyById,
  invalidateFamilyKeyCache,
  isKnownMissingKey,
  rememberMissingKey,
  setCachedKey,
  type CachedKeyRow,
} from '../../src/keys/cache.js';
import { redis } from '../../src/db/redis.js';

/**
 * The key cache, against the real Redis. These used to mock the pipeline
 * call by call; asserting on what ends up in Redis is what matters.
 */
describe('key caching in Redis', () => {
  function makeRow(): { publicId: string; row: CachedKeyRow } {
    const id = randomUUID();
    return {
      publicId: `pub${id.slice(0, 8)}`,
      row: {
        id,
        orgId: randomUUID(),
        familyId: randomUUID(),
        env: 'test',
        scopes: ['mock:read'],
        status: 'active',
        secretHash: 'abcdef1234567890',
        expiresAt: null,
        graceUntil: null,
        familyRevokedAt: null,
      },
    };
  }

  it('round-trips a cached row', async () => {
    const { publicId, row } = makeRow();
    await setCachedKey(publicId, row, 60);
    expect(await getCachedKey(publicId)).toEqual(row);
    expect(await redis.get(`cache:key:id:${row.id}`)).toBe(publicId);
    expect(await redis.sismember(`cache:family:${row.familyId}:keys`, publicId)).toBe(1);
  });

  it('returns null on cache miss', async () => {
    expect(await getCachedKey(`missing-${randomUUID()}`)).toBeNull();
  });

  it('invalidates by publicId', async () => {
    const { publicId, row } = makeRow();
    await setCachedKey(publicId, row, 60);
    await invalidateCachedKey(publicId);
    expect(await getCachedKey(publicId)).toBeNull();
  });

  it('invalidates by keyId', async () => {
    const { publicId, row } = makeRow();
    await setCachedKey(publicId, row, 60);
    await invalidateCachedKeyById(row.id);
    expect(await getCachedKey(publicId)).toBeNull();
    expect(await redis.get(`cache:key:id:${row.id}`)).toBeNull();
  });

  it('invalidates a whole family', async () => {
    const first = makeRow();
    const second = makeRow();
    second.row.familyId = first.row.familyId;
    await setCachedKey(first.publicId, first.row, 60);
    await setCachedKey(second.publicId, second.row, 60);

    await invalidateFamilyKeyCache(first.row.familyId);

    expect(await getCachedKey(first.publicId)).toBeNull();
    expect(await getCachedKey(second.publicId)).toBeNull();
  });

  it('refuses to write a row back over a fresh invalidation', async () => {
    // The revoke race: a verification read the row just before the revoke,
    // and writes it to the cache just after the revoke cleared it. The
    // tombstone left by the invalidation must win.
    const { publicId, row } = makeRow();
    await invalidateCachedKey(publicId);
    await setCachedKey(publicId, row, 60);
    expect(await getCachedKey(publicId)).toBeNull();
  });

  it('remembers unknown public ids briefly', async () => {
    const publicId = `unknown${randomUUID().slice(0, 8)}`;
    expect(await isKnownMissingKey(publicId)).toBe(false);
    await rememberMissingKey(publicId);
    expect(await isKnownMissingKey(publicId)).toBe(true);
  });
});
