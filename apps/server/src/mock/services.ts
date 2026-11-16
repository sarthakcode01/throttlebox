import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import Redis from 'ioredis';
import { config } from '../config.js';
import { redis } from '../db/redis.js';
import { mockRoutes, mockServices } from '../db/schema.js';
import type {
  CreateMockRouteRequest,
  CreateMockServiceRequest,
  HttpMethod,
  MockRouteSummary,
  MockServiceSummary,
} from '@throttlebox/shared';
import {
  buildServiceRouter,
  normalizePath,
  routePathError,
  type RouteDefinition,
  type ServiceRouter,
} from './router.js';

export class MockError extends Error {
  constructor(
    public code: 'not_found' | 'duplicate' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'MockError';
  }
}

/**
 * Built routers, keyed by `orgId:slug` — the shape of an incoming request.
 *
 * The cache used to be keyed by service id, which meant every request still
 * ran a Postgres query to turn the slug into an id before it could look the
 * router up, and the chaos hook and the handler each did it again. Keyed by
 * slug, a warm request touches no database at all.
 *
 * Entries are invalidated whenever a service or its routes change, and also
 * expire, so a missed pub/sub message cannot leave a stale router forever.
 */
interface CachedRouter {
  router: ServiceRouter;
  expiresAt: number;
}

const ROUTER_CACHE_TTL_MS = 60_000;
const routerCache = new Map<string, CachedRouter>();
const ROUTER_INVALIDATE_CHANNEL = 'router:invalidated';
let routerSubscriberRedis: Redis | null = null;

/**
 * Bumped on every invalidation. A lookup that started before an
 * invalidation must not write its (possibly stale) router back afterwards —
 * without this, a read racing an edit could pin the old routes in the cache.
 */
let routerGeneration = 0;

function routerCacheKey(orgId: string, slug: string): string {
  return `${orgId}:${slug}`;
}

export function invalidateRouterCache(serviceId?: string, broadcast = true): void {
  routerGeneration += 1;

  if (serviceId) {
    for (const [key, entry] of routerCache) {
      if (entry.router.serviceId === serviceId) routerCache.delete(key);
    }
  } else {
    routerCache.clear();
  }

  if (broadcast) {
    try {
      void redis
        .publish(ROUTER_INVALIDATE_CHANNEL, JSON.stringify({ serviceId: serviceId ?? null }))
        .catch((err) => {
          console.warn('[mock:pubsub] Failed to publish router invalidation:', err);
        });
    } catch (err) {
      console.warn('[mock:pubsub] Failed to broadcast router invalidation:', err);
    }
  }
}

export function startRouterPubSub(): void {
  if (routerSubscriberRedis) return;

  try {
    routerSubscriberRedis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    routerSubscriberRedis.subscribe(ROUTER_INVALIDATE_CHANNEL, (err) => {
      if (err) {
        console.error('[mock:pubsub] Failed to subscribe to router invalidations:', err.message);
      }
    });

    routerSubscriberRedis.on('message', (channel, message) => {
      if (channel === ROUTER_INVALIDATE_CHANNEL) {
        try {
          const { serviceId } = JSON.parse(message) as { serviceId?: string | null };
          invalidateRouterCache(serviceId ?? undefined, false);
        } catch (err) {
          console.error('[mock:pubsub] Failed to parse message:', err);
        }
      }
    });

    routerSubscriberRedis.on('error', (err) => {
      console.error('[mock:pubsub] Subscriber Redis error:', err.message);
    });
  } catch (err) {
    console.error('[mock:pubsub] Failed to initialize router subscriber:', err);
  }
}

export async function stopRouterPubSub(): Promise<void> {
  if (routerSubscriberRedis) {
    try {
      await routerSubscriberRedis.unsubscribe(ROUTER_INVALIDATE_CHANNEL);
      routerSubscriberRedis.disconnect();
    } catch {
      // ignore on shutdown
    } finally {
      routerSubscriberRedis = null;
    }
  }
}

/** Turn a name into a URL-safe slug. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function toServiceSummary(
  row: typeof mockServices.$inferSelect,
  routeCount: number,
): MockServiceSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isSeeded: row.isSeeded,
    routeCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRouteSummary(row: typeof mockRoutes.$inferSelect): MockRouteSummary {
  return {
    id: row.id,
    serviceId: row.serviceId,
    method: row.method,
    path: row.path,
    summary: row.summary,
    description: row.description,
    statusCode: row.statusCode,
    responseTemplate: row.responseTemplate,
    responseHeaders: (row.responseHeaders ?? {}) as Record<string, string>,
    latencyMs: row.latencyMs,
    isActive: row.isActive,
    position: row.position,
  };
}

export async function listServices(orgId: string): Promise<MockServiceSummary[]> {
  const services = await db
    .select()
    .from(mockServices)
    .where(eq(mockServices.orgId, orgId))
    .orderBy(asc(mockServices.createdAt));

  if (services.length === 0) return [];

  const counts = await db
    .select({ serviceId: mockRoutes.serviceId, id: mockRoutes.id })
    .from(mockRoutes)
    .where(
      inArray(
        mockRoutes.serviceId,
        services.map((service) => service.id),
      ),
    );

  const countsByService = new Map<string, number>();
  for (const row of counts) {
    countsByService.set(row.serviceId, (countsByService.get(row.serviceId) ?? 0) + 1);
  }

  return services.map((service) => toServiceSummary(service, countsByService.get(service.id) ?? 0));
}

export async function getServiceBySlug(
  orgId: string,
  slug: string,
): Promise<typeof mockServices.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(mockServices)
    .where(and(eq(mockServices.orgId, orgId), eq(mockServices.slug, slug)))
    .limit(1);

  return row ?? null;
}

export async function getServiceById(
  orgId: string,
  id: string,
): Promise<typeof mockServices.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(mockServices)
    .where(and(eq(mockServices.orgId, orgId), eq(mockServices.id, id)))
    .limit(1);

  return row ?? null;
}

export async function createService(
  orgId: string,
  input: CreateMockServiceRequest,
): Promise<MockServiceSummary> {
  const slug = slugify(input.slug ?? input.name);
  if (!slug) {
    throw new MockError('invalid', 'A service needs a name that produces a URL slug');
  }

  const existing = await getServiceBySlug(orgId, slug);
  if (existing) {
    throw new MockError('duplicate', `A service with the slug "${slug}" already exists`);
  }

  let row: typeof mockServices.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(mockServices)
      .values({
        orgId,
        name: input.name,
        slug,
        description: input.description ?? '',
      })
      .returning();
  } catch (err) {
    // A concurrent create took the slug between the check and the insert.
    if (isUniqueViolation(err)) {
      throw new MockError('duplicate', `A service with the slug "${slug}" already exists`);
    }
    throw err;
  }

  if (!row) throw new MockError('invalid', 'Failed to create the service');
  return toServiceSummary(row, 0);
}

export async function updateService(
  orgId: string,
  id: string,
  input: Partial<CreateMockServiceRequest>,
): Promise<MockServiceSummary> {
  const existing = await getServiceById(orgId, id);
  if (!existing) throw new MockError('not_found', 'Service not found');

  const slug = input.slug ? slugify(input.slug) : existing.slug;
  // `createService` refuses a name that slugifies to nothing; an update
  // must too, or the service ends up with an empty, unreachable slug.
  if (!slug) {
    throw new MockError('invalid', 'A service needs a slug with at least one letter or digit');
  }
  if (slug !== existing.slug) {
    const clash = await getServiceBySlug(orgId, slug);
    if (clash) throw new MockError('duplicate', `A service with the slug "${slug}" already exists`);
  }

  let row: typeof mockServices.$inferSelect | undefined;
  try {
    [row] = await db
      .update(mockServices)
      .set({
        name: input.name ?? existing.name,
        slug,
        description: input.description ?? existing.description,
        updatedAt: new Date(),
      })
      .where(eq(mockServices.id, id))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MockError('duplicate', `A service with the slug "${slug}" already exists`);
    }
    throw err;
  }

  if (!row) throw new MockError('not_found', 'Service not found');

  // The cache is keyed by slug, so a rename must drop the old entry.
  invalidateRouterCache(id);

  const routes = await listRoutes(orgId, id);
  return toServiceSummary(row, routes.length);
}

export async function deleteService(orgId: string, id: string): Promise<void> {
  const existing = await getServiceById(orgId, id);
  if (!existing) throw new MockError('not_found', 'Service not found');
  if (existing.isSeeded) {
    throw new MockError('invalid', 'Seeded services cannot be deleted');
  }

  await db.delete(mockServices).where(eq(mockServices.id, id));
  invalidateRouterCache(id);
}

export async function listRoutes(orgId: string, serviceId: string): Promise<MockRouteSummary[]> {
  const service = await getServiceById(orgId, serviceId);
  if (!service) throw new MockError('not_found', 'Service not found');

  const rows = await db
    .select()
    .from(mockRoutes)
    .where(eq(mockRoutes.serviceId, serviceId))
    .orderBy(asc(mockRoutes.position), asc(mockRoutes.createdAt));

  return rows.map(toRouteSummary);
}

/** Routes for a service, as router definitions. */
async function routeDefinitions(serviceId: string): Promise<RouteDefinition[]> {
  const rows = await db
    .select()
    .from(mockRoutes)
    .where(and(eq(mockRoutes.serviceId, serviceId), eq(mockRoutes.isActive, true)))
    .orderBy(asc(mockRoutes.position), asc(mockRoutes.createdAt));

  return rows.map((row) => ({
    id: row.id,
    method: row.method,
    path: row.path,
    statusCode: row.statusCode,
    responseTemplate: row.responseTemplate,
    responseHeaders: (row.responseHeaders ?? {}) as Record<string, string>,
    latencyMs: row.latencyMs,
  }));
}

/**
 * The router for a service, built once and cached.
 *
 * The cache is keyed by service id and dropped whenever that service's routes
 * change, so an edit takes effect on the next request.
 */
export async function getServiceRouter(orgId: string, slug: string): Promise<ServiceRouter | null> {
  const key = routerCacheKey(orgId, slug);
  const cached = routerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.router;

  const generation = routerGeneration;

  const service = await getServiceBySlug(orgId, slug);
  if (!service) return null;

  const definitions = await routeDefinitions(service.id);
  const router = buildServiceRouter(service.id, definitions);

  if (generation === routerGeneration) {
    routerCache.set(key, { router, expiresAt: Date.now() + ROUTER_CACHE_TTL_MS });
  }

  return router;
}

/** Validate and normalise a route path before it is stored. */
function prepareRoutePath(method: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/')) {
    throw new MockError('invalid', 'A route path must start with "/"');
  }

  // Store the same form the router matches on. Uniqueness used to be
  // checked on the raw path, so `/products` and `/products/` were both
  // accepted — and then collided inside the router.
  const path = normalizePath(trimmed);
  const problem = routePathError(method, path);
  if (problem) {
    throw new MockError('invalid', `Invalid route path: ${problem}`);
  }
  return path;
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === UNIQUE_VIOLATION;
}

export async function createRoute(
  orgId: string,
  serviceId: string,
  input: CreateMockRouteRequest,
): Promise<MockRouteSummary> {
  const service = await getServiceById(orgId, serviceId);
  if (!service) throw new MockError('not_found', 'Service not found');

  const path = prepareRoutePath(input.method, input.path);

  const existing = await db
    .select({ id: mockRoutes.id })
    .from(mockRoutes)
    .where(
      and(
        eq(mockRoutes.serviceId, serviceId),
        eq(mockRoutes.method, input.method),
        eq(mockRoutes.path, path),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new MockError('duplicate', `${input.method} ${path} already exists on this service`);
  }

  let row: typeof mockRoutes.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(mockRoutes)
      .values({
        serviceId,
        method: input.method as HttpMethod,
        path,
        summary: input.summary ?? '',
        description: input.description ?? '',
        statusCode: input.statusCode ?? 200,
        responseTemplate: input.responseTemplate ?? {},
        responseHeaders: input.responseHeaders ?? {},
        latencyMs: input.latencyMs ?? 0,
        isActive: input.isActive ?? true,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MockError('duplicate', `${input.method} ${path} already exists on this service`);
    }
    throw err;
  }

  if (!row) throw new MockError('invalid', 'Failed to create the route');

  invalidateRouterCache(serviceId);
  return toRouteSummary(row);
}

/**
 * Update a route.
 *
 * The unique index on (service, method, path) is the real guard against
 * duplicates, so the check here is a courtesy that produces a useful error
 * message. The violation can still arrive from the index, so it is caught
 * here rather than being allowed to surface as an unhandled database error.
 */
export async function updateRoute(
  orgId: string,
  routeId: string,
  input: Partial<CreateMockRouteRequest>,
): Promise<MockRouteSummary> {
  const [existing] = await db
    .select()
    .from(mockRoutes)
    .innerJoin(mockServices, eq(mockRoutes.serviceId, mockServices.id))
    .where(and(eq(mockRoutes.id, routeId), eq(mockServices.orgId, orgId)))
    .limit(1);

  if (!existing) throw new MockError('not_found', 'Route not found');

  const route = existing.mock_routes;

  const method = input.method ?? route.method;
  const path = input.path === undefined ? route.path : prepareRoutePath(method, input.path);

  if (method !== route.method || path !== route.path) {
    const clash = await db
      .select({ id: mockRoutes.id })
      .from(mockRoutes)
      .where(
        and(
          eq(mockRoutes.serviceId, route.serviceId),
          eq(mockRoutes.method, method),
          eq(mockRoutes.path, path),
          ne(mockRoutes.id, routeId),
        ),
      )
      .limit(1);

    if (clash.length > 0) {
      throw new MockError('duplicate', `${method} ${path} already exists on this service`);
    }
  }

  let row: typeof mockRoutes.$inferSelect | undefined;

  try {
    [row] = await db
      .update(mockRoutes)
      .set({
        method,
        path,
        summary: input.summary ?? route.summary,
        description: input.description ?? route.description,
        statusCode: input.statusCode ?? route.statusCode,
        responseTemplate:
          input.responseTemplate === undefined ? route.responseTemplate : input.responseTemplate,
        responseHeaders: input.responseHeaders ?? route.responseHeaders,
        latencyMs: input.latencyMs ?? route.latencyMs,
        isActive: input.isActive ?? route.isActive,
        updatedAt: new Date(),
      })
      .where(eq(mockRoutes.id, routeId))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MockError('duplicate', `${method} ${path} already exists on this service`);
    }
    throw err;
  }

  if (!row) throw new MockError('not_found', 'Route not found');

  invalidateRouterCache(route.serviceId);
  return toRouteSummary(row);
}

export async function deleteRoute(orgId: string, routeId: string): Promise<void> {
  const [existing] = await db
    .select({ serviceId: mockRoutes.serviceId })
    .from(mockRoutes)
    .innerJoin(mockServices, eq(mockRoutes.serviceId, mockServices.id))
    .where(and(eq(mockRoutes.id, routeId), eq(mockServices.orgId, orgId)))
    .limit(1);

  if (!existing) throw new MockError('not_found', 'Route not found');

  await db.delete(mockRoutes).where(eq(mockRoutes.id, routeId));
  invalidateRouterCache(existing.serviceId);
}
