import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEY_SCOPE,
  KEY_SCOPES,
  PLAN_CONFIGS,
  PLAN_LIMITS,
  PLANS,
  ROLES,
  roleHasPermission,
} from '../src/index.js';

describe('plan configuration', () => {
  it('defines a config for every plan, keyed by its own id', () => {
    for (const plan of PLANS) expect(PLAN_CONFIGS[plan].id).toBe(plan);
  });

  it('free = 100/hour, no burst; pro = 5000/hour with 20% burst', () => {
    expect(PLAN_CONFIGS.free).toMatchObject({
      requestsPerWindow: 100,
      windowSeconds: 3600,
      burstAllowance: 1,
    });
    expect(PLAN_CONFIGS.pro).toMatchObject({
      requestsPerWindow: 5000,
      windowSeconds: 3600,
      burstAllowance: 1.2,
    });
    expect(Math.floor(PLAN_CONFIGS.pro.requestsPerWindow * PLAN_CONFIGS.pro.burstAllowance)).toBe(
      6000,
    );
  });

  it('pro is strictly more generous than free', () => {
    expect(PLAN_CONFIGS.pro.requestsPerWindow).toBeGreaterThan(PLAN_CONFIGS.free.requestsPerWindow);
  });

  it('keeps the legacy PLAN_LIMITS table in sync with PLAN_CONFIGS', () => {
    for (const plan of PLANS) {
      expect(PLAN_LIMITS[plan]).toEqual({
        requests: PLAN_CONFIGS[plan].requestsPerWindow,
        windowSeconds: PLAN_CONFIGS[plan].windowSeconds,
        burstAllowance: PLAN_CONFIGS[plan].burstAllowance,
      });
    }
  });
});

describe('key scopes', () => {
  it('defaults to least privilege', () => {
    expect(DEFAULT_KEY_SCOPE).toBe('mock:read');
    expect(KEY_SCOPES).toContain(DEFAULT_KEY_SCOPE);
  });
});

describe('permissions used by the Phase 4-6 routes', () => {
  const matrix: Array<[string, boolean, boolean, boolean, boolean]> = [
    // permission,               owner, admin, dev,   viewer
    ['org:update_plan', true, true, false, false],
    ['chaos:read', true, true, true, false],
    ['chaos:write', true, true, true, false],
    ['analytics:read', true, true, true, true],
    ['analytics:write', true, true, true, false],
    ['mock:create', true, true, true, false],
    ['mock:write', true, true, true, false],
    ['mock:read', true, true, true, true],
    ['keys:create', true, true, true, false],
    ['keys:read', true, true, true, true],
  ];

  it.each(matrix)('%s', (permission, owner, admin, dev, viewer) => {
    expect(roleHasPermission('owner', permission)).toBe(owner);
    expect(roleHasPermission('admin', permission)).toBe(admin);
    expect(roleHasPermission('dev', permission)).toBe(dev);
    expect(roleHasPermission('viewer', permission)).toBe(viewer);
  });

  it('every role is covered by the matrix helper', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'dev', 'viewer']);
  });

  it('wildcards match by prefix only, so "chaos:*" does not grant "chaosX:read"', () => {
    expect(roleHasPermission('dev', 'chaosX:read')).toBe(false);
  });
});
