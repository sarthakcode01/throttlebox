/**
 * Shared types and constants used by both the API server and the web app.
 *
 * This package is compiled to `dist/` (see `tsconfig.build.json`) and consumed
 * as an ordinary workspace dependency, so the server's production build can
 * emit plain JavaScript that Node can run.
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
  admin: ['keys:*', 'members:invite', 'plugins:deploy', 'mock:*', 'chaos:*', 'org:*', 'analytics:*'],
  dev: ['keys:create', 'keys:read', 'keys:rotate', 'keys:revoke', 'mock:*', 'chaos:*', 'analytics:*'],
  viewer: ['keys:read', 'mock:read', 'analytics:read'],
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
// Plans & Rate Limiting (Phase 4)
// ---------------------------------------------------------------------------

export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanConfig {
  id: Plan;
  name: string;
  requestsPerWindow: number;
  windowSeconds: number;
  burstAllowance: number;
}

export const PLAN_CONFIGS: Record<Plan, PlanConfig> = {
  free: {
    id: 'free',
    name: 'Free',
    requestsPerWindow: 100,
    windowSeconds: 3600,
    burstAllowance: 1.0,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    requestsPerWindow: 5000,
    windowSeconds: 3600,
    burstAllowance: 1.2,
  },
};

export const PLAN_LIMITS: Record<
  Plan,
  { requests: number; windowSeconds: number; burstAllowance: number }
> = {
  free: { requests: 100, windowSeconds: 3600, burstAllowance: 1.0 },
  pro: { requests: 5000, windowSeconds: 3600, burstAllowance: 1.2 },
};

export interface UpdateOrgPlanRequest {
  plan: Plan;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix epoch seconds
  retryAfter?: number; // seconds (present if allowed === false)
}

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
// API keys (Phase 2)
// ---------------------------------------------------------------------------

export const KEY_ENVS = ['test', 'live'] as const;
export type KeyEnv = (typeof KEY_ENVS)[number];

export const KEY_STATUSES = ['active', 'revoked'] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

/**
 * Scopes a key can carry. A key with an empty scope list is treated as
 * `mock:read` only — never "empty means everything".
 */
export const KEY_SCOPES = ['mock:read', 'mock:write', 'chaos:write', 'keys:read'] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** The scope a key gets when the caller asks for none. */
export const DEFAULT_KEY_SCOPE: KeyScope = 'mock:read';

/** A key is masked like this in every list response. */
export interface ApiKeySummary {
  id: string;
  familyId: string;
  name: string;
  /** e.g. `sk_live_9Kd2mQxR7tYb…eU` — never the full secret. */
  display: string;
  env: KeyEnv;
  status: KeyStatus;
  scopes: KeyScope[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  graceUntil: string | null;
  createdAt: string;
}

/**
 * The only response that ever contains the raw key. It is returned exactly
 * once, at creation or rotation, and is not retrievable afterwards.
 */
export interface ApiKeyCreatedResponse {
  id: string;
  familyId: string;
  /** The raw key. Shown once. */
  key: string;
  prefix: string;
  last4: string;
  env: KeyEnv;
  scopes: KeyScope[];
  expiresAt: string | null;
  warning: string;
}

export interface CreateKeyRequest {
  name: string;
  env: KeyEnv;
  scopes?: KeyScope[];
  expiresInDays?: number | null;
}

export interface RotateKeyRequest {
  /** Grace window during which the old key still works. Defaults to 24h. */
  graceHours?: number;
}

export interface ApiKeyListResponse {
  keys: ApiKeySummary[];
}

// ---------------------------------------------------------------------------
// Mock API engine (Phase 3)
// ---------------------------------------------------------------------------

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface MockServiceSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  isSeeded: boolean;
  /** How many active routes the service has. */
  routeCount: number;
  createdAt: string;
}

export interface MockRouteSummary {
  id: string;
  serviceId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  statusCode: number;
  responseTemplate: unknown;
  responseHeaders: Record<string, string>;
  latencyMs: number;
  isActive: boolean;
  position: number;
}

export interface CreateMockServiceRequest {
  name: string;
  slug?: string;
  description?: string;
}

export interface CreateMockRouteRequest {
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  statusCode?: number;
  responseTemplate?: unknown;
  responseHeaders?: Record<string, string>;
  latencyMs?: number;
  isActive?: boolean;
}

/**
 * A rendered mock response, returned by the preview endpoint so the dashboard
 * can show exactly what a caller would receive.
 */
export interface MockPreviewResponse {
  statusCode: number;
  headers: Record<string, string>;
  /** The serialized body, exactly as it goes over the wire. */
  body: string;
  /** Which route matched. */
  matchedRoute: string | null;
  /** Milliseconds the artificial latency would add. */
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Analytics & Logging (Phase 5)
// ---------------------------------------------------------------------------

export interface RequestLogSummary {
  time: string;
  keyId: string | null;
  keyDisplay?: string | null;
  orgId: string;
  serviceId: string | null;
  serviceSlug?: string | null;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  rateLimited: boolean;
  traceId: string;
}

export interface AnalyticsOverview {
  totalRequests: number;
  errorRate: number; // percentage (0 - 100)
  p95LatencyMs: number;
  throttledRequests: number;
  activeKeysCount: number;
}

export interface AnalyticsUsageBucket {
  bucket: string; // ISO timestamp
  requests: number;
  errors: number;
  throttled: number;
}

export interface AnalyticsLatencyBucket {
  bucket: string; // ISO timestamp
  p50: number;
  p95: number;
  p99: number;
}

export interface AnalyticsErrorsBreakdown {
  status2xx: number;
  status4xx: number;
  status429: number;
  status5xx: number;
  topErrorPaths: { path: string; count: number; statusCode: number }[];
}

export interface WebhookConfig {
  id: string;
  orgId: string;
  url: string;
  secret: string; // HMAC secret
  isActive: boolean;
  lastAlertedThreshold: number | null;
  createdAt: string;
}

export interface CreateWebhookRequest {
  url: string;
  secret?: string;
}

// ---------------------------------------------------------------------------
// Chaos Engineering Controls (Phase 6)
// ---------------------------------------------------------------------------

export type ChaosLatencyDistribution = 'fixed' | 'normal' | 'uniform';

export interface ChaosLatencyConfig {
  enabled: boolean;
  distribution: ChaosLatencyDistribution;
  /** Mean delay in milliseconds (or fixed delay). */
  meanMs: number;
  /** Standard deviation in milliseconds (for normal distribution). */
  stddevMs: number;
  /** Minimum floor in milliseconds. */
  minMs?: number;
  /** Maximum ceiling in milliseconds. */
  maxMs?: number;
}

export interface ChaosErrorConfig {
  enabled: boolean;
  /** Probability of 5xx errors between 0.00 and 1.00 (e.g. 0.05 = 5%). */
  rate5xx: number;
  /** Probability of simulated 429 errors between 0.00 and 1.00. */
  rate429: number;
  /** Specific 5xx status codes to cycle through (e.g. [500, 502, 503, 504]). */
  statusCodes: number[];
  /** Optional custom error message/payload. */
  customMessage?: string;
}

export interface ChaosPartitionConfig {
  enabled: boolean;
  /** Probability of dropping the TCP connection (0.00 to 1.00). */
  dropRate: number;
}

export interface ChaosRuleConfig {
  id: string;
  orgId: string;
  /** Optional key scoping. Null = applies to all keys in the org. */
  keyId?: string | null;
  /** Optional service scoping. Null = applies to all services in the org. */
  serviceId?: string | null;
  isEnabled: boolean;
  latency: ChaosLatencyConfig;
  errors: ChaosErrorConfig;
  partition: ChaosPartitionConfig;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateChaosRuleRequest {
  serviceId?: string | null;
  keyId?: string | null;
  isEnabled: boolean;
  latency: ChaosLatencyConfig;
  errors: ChaosErrorConfig;
  partition: ChaosPartitionConfig;
}

export interface ChaosBenchmarkRequest {
  serviceSlug: string;
  requestCount?: number; // default: 100, max: 200
  concurrency?: number; // default: 10, max: 25
}

export interface ChaosBenchmarkResult {
  totalRequests: number;
  successful: number;
  errors5xx: number;
  throttled429: number;
  dropped: number;
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  histogram: {
    bracket: string;
    count: number;
  }[];
}

