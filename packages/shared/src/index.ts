/**
 * Shared types and constants used by both the API server and the web app.
 * This package is consumed as TypeScript source (no build step) so that
 * types stay in sync across the monorepo.
 */

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

export const ROLES = ['owner', 'admin', 'dev', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Permission matrix. A role grants a permission if it has the exact string or
 * a wildcard prefix ending in `*` (e.g. `keys:*` matches `keys:create`).
 */
export const PERMISSIONS: Record<Role, readonly string[]> = {
  owner: ['*'],
  admin: ['keys:*', 'members:invite', 'plugins:deploy', 'mock:*', 'chaos:*'],
  dev: ['keys:create', 'keys:rotate', 'mock:*', 'chaos:*'],
  viewer: ['keys:read'],
};

export function roleHasPermission(role: Role, permission: string): boolean {
  const grants = PERMISSIONS[role];
  return grants.some((granted) => {
    if (granted === '*') return true;
    if (granted.endsWith('*')) {
      return permission.startsWith(granted.slice(0, -1));
    }
    return granted === permission;
  });
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_LIMITS: Record<Plan, { requests: number; windowSeconds: number }> = {
  free: { requests: 100, windowSeconds: 3600 },
  pro: { requests: 5000, windowSeconds: 3600 },
};

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  timestamp: string;
  version: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface MeResponse {
  user: SessionUser;
  org: {
    id: string;
    name: string;
    plan: Plan;
  };
  role: Role;
}

export interface AuthErrorResponse {
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// API keys (Phase 2 — types only for now)
// ---------------------------------------------------------------------------

export const KEY_ENVS = ['test', 'live'] as const;
export type KeyEnv = (typeof KEY_ENVS)[number];

export const KEY_STATUSES = ['active', 'revoked'] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];
