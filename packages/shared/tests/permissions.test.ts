import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PLAN_LIMITS, roleHasPermission } from '../src/index.js';

describe('roleHasPermission', () => {
  it('grants everything to owners', () => {
    expect(roleHasPermission('owner', 'keys:create')).toBe(true);
    expect(roleHasPermission('owner', 'anything:at:all')).toBe(true);
  });

  it('honours prefix wildcards', () => {
    expect(roleHasPermission('admin', 'keys:create')).toBe(true);
    expect(roleHasPermission('admin', 'keys:revoke')).toBe(true);
    // admin has keys:* but not members:remove
    expect(roleHasPermission('admin', 'members:invite')).toBe(true);
  });

  it('restricts dev to key actions only', () => {
    expect(roleHasPermission('dev', 'keys:create')).toBe(true);
    expect(roleHasPermission('dev', 'keys:read')).toBe(true);
    expect(roleHasPermission('dev', 'keys:rotate')).toBe(true);
    expect(roleHasPermission('dev', 'keys:revoke')).toBe(true);

    // A dev manages keys and mocks, but does not administer the workspace.
    expect(roleHasPermission('dev', 'members:invite')).toBe(false);
  });

  it('gives viewers read-only access', () => {
    expect(roleHasPermission('viewer', 'keys:read')).toBe(true);
    expect(roleHasPermission('viewer', 'keys:create')).toBe(false);
  });

  it('does not grant owner-only wildcard strings by prefix accident', () => {
    expect(roleHasPermission('dev', 'wildcard')).toBe(false);
  });
});

describe('PLAN_LIMITS', () => {
  it('defines a limit for every plan', () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual(['free', 'pro']);
  });
});

describe('PERMISSIONS', () => {
  it('covers all four roles', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(['admin', 'dev', 'owner', 'viewer']);
  });
});
