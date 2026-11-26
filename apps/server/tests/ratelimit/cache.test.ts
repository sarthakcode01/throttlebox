import { describe, expect, it, vi } from 'vitest';
import {
  getCachedKey,
  invalidateCachedKey,
  invalidateCachedKeyById,
  invalidateFamilyKeyCache,
  setCachedKey,
  type CachedKeyRow,
} from '../../src/keys/cache.js';
import { redis } from '../../src/db/redis.js';

describe('key caching in Redis', () => {
  const dummyRow: CachedKeyRow = {
    id: 'key-123',
    orgId: 'org-456',
    familyId: 'fam-789',
    env: 'test',
    scopes: ['mock:read'],
    status: 'active',
    expiresAt: null,
    graceUntil: null,
    familyRevokedAt: null,
  };

  it('serializes and retrieves cached key', async () => {
    vi.spyOn(redis, 'get').mockResolvedValueOnce(JSON.stringify(dummyRow));

    const result = await getCachedKey('testpub123');
    expect(result).toEqual(dummyRow);
    expect(redis.get).toHaveBeenCalledWith('cache:key:testpub123');
  });

  it('never stores the secret hash in Redis', async () => {
    // A cached row must carry lifecycle state only: a Redis compromise should
    // not hand over verifiable credential digests.
    const serialised = JSON.stringify(dummyRow);
    expect(serialised).not.toContain('secretHash');
  });

  it('returns null on cache miss', async () => {
    vi.spyOn(redis, 'get').mockResolvedValueOnce(null);

    const result = await getCachedKey('nonexistent');
    expect(result).toBeNull();
  });

  it('sets cache using a pipeline', async () => {
    const pipelineMock = {
      setex: vi.fn().mockReturnThis(),
      sadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    vi.spyOn(redis, 'pipeline').mockReturnValue(
      pipelineMock as unknown as ReturnType<typeof redis.pipeline>,
    );

    await setCachedKey('testpub123', dummyRow, 60);

    expect(pipelineMock.setex).toHaveBeenCalledWith(
      'cache:key:testpub123',
      60,
      JSON.stringify(dummyRow),
    );
    expect(pipelineMock.setex).toHaveBeenCalledWith('cache:key:id:key-123', 60, 'testpub123');
    expect(pipelineMock.sadd).toHaveBeenCalledWith('cache:family:fam-789:keys', 'testpub123');
    expect(pipelineMock.exec).toHaveBeenCalled();
  });

  it('invalidates key cache by publicId', async () => {
    vi.spyOn(redis, 'del').mockResolvedValueOnce(1);

    await invalidateCachedKey('testpub123');
    expect(redis.del).toHaveBeenCalledWith('cache:key:testpub123');
  });

  it('invalidates key cache by keyId', async () => {
    vi.spyOn(redis, 'get').mockResolvedValueOnce('testpub123');
    const pipelineMock = {
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    vi.spyOn(redis, 'pipeline').mockReturnValue(
      pipelineMock as unknown as ReturnType<typeof redis.pipeline>,
    );

    await invalidateCachedKeyById('key-123');
    expect(pipelineMock.del).toHaveBeenCalledWith('cache:key:id:key-123');
    expect(pipelineMock.del).toHaveBeenCalledWith('cache:key:testpub123');
    expect(pipelineMock.exec).toHaveBeenCalled();
  });

  it('invalidates whole family key cache', async () => {
    vi.spyOn(redis, 'smembers').mockResolvedValueOnce([
      'key-pub-1',
      'key-pub-2',
    ] as unknown as string[]);
    const pipelineMock = {
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    vi.spyOn(redis, 'pipeline').mockReturnValue(
      pipelineMock as unknown as ReturnType<typeof redis.pipeline>,
    );

    await invalidateFamilyKeyCache('fam-789');
    expect(pipelineMock.del).toHaveBeenCalledWith('cache:key:key-pub-1');
    expect(pipelineMock.del).toHaveBeenCalledWith('cache:key:key-pub-2');
    expect(pipelineMock.del).toHaveBeenCalledWith('cache:family:fam-789:keys');
    expect(pipelineMock.exec).toHaveBeenCalled();
  });
});
