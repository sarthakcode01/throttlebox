import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PLAN_CONFIGS } from '@throttlebox/shared';
import { getOrgPlan, invalidateOrgPlan, updateOrgPlan } from '../../src/ratelimit/tier.js';
import { redis } from '../../src/db/redis.js';
import { db } from '../../src/db/client.js';

describe('tier plan resolution and caching', () => {
  beforeEach(async () => {
    vi.spyOn(redis, 'del').mockResolvedValue(1);
    vi.spyOn(redis, 'setex').mockResolvedValue('OK');
    await invalidateOrgPlan('org-test-plan');
  });

  it('resolves free plan by default on database miss', async () => {
    vi.spyOn(redis, 'get').mockResolvedValue(null);
    vi.spyOn(db, 'select').mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const plan = await getOrgPlan('org-test-plan');
    expect(plan).toEqual(PLAN_CONFIGS.free);
  });

  it('uses in-memory cache on subsequent lookups', async () => {
    const getSpy = vi.spyOn(redis, 'get').mockResolvedValue(null);
    const selectSpy = vi.spyOn(db, 'select').mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    // First call populates in-memory cache
    await getOrgPlan('org-test-plan');
    getSpy.mockClear();
    selectSpy.mockClear();

    // Second call should return immediately from in-memory cache
    const secondCall = await getOrgPlan('org-test-plan');

    expect(secondCall).toEqual(PLAN_CONFIGS.free);
    expect(getSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('updates org plan in db and publishes to Redis channel', async () => {
    vi.spyOn(db, 'update').mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as ReturnType<typeof db.update>);

    const publishSpy = vi.spyOn(redis, 'publish').mockResolvedValue(1);

    const updated = await updateOrgPlan('org-test-plan', 'pro');
    expect(updated).toEqual(PLAN_CONFIGS.pro);
    expect(publishSpy).toHaveBeenCalledWith(
      'plan:changed',
      JSON.stringify({ orgId: 'org-test-plan', plan: 'pro' }),
    );
  });
});
