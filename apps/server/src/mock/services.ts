import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mockRoutes, mockServices } from '../db/schema.js';
import type {
  CreateMockRouteRequest,
  CreateMockServiceRequest,
  HttpMethod,
  MockRouteSummary,
  MockServiceSummary,
} from '@throttlebox/shared';
import { buildServiceRouter, type RouteDefinition, type ServiceRouter } from './router.js';

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
 * Built routers, keyed by service id.
 *
 * Rebuilding a router is cheap (a handful of routes), but doing it on every
 * request would still mean a query per request. The cache is invalidated
 * whenever a service's routes change, so an edit is visible immediately.
 */
const routerCache = new Map<string, ServiceRouter>();

export function invalidateRouterCache(serviceId?: string): void {
  if (serviceId) {
    routerCache.delete(serviceId);
    return;
  }
  routerCache.clear();
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

  const [row] = await db
    .insert(mockServices)
    .values({
      orgId,
      name: input.name,
      slug,
      description: input.description ?? '',
    })
    .returning();

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
  if (slug !== existing.slug) {
    const clash = await getServiceBySlug(orgId, slug);
    if (clash) throw new MockError('duplicate', `A service with the slug "${slug}" already exists`);
  }

  const [row] = await db
    .update(mockServices)
    .set({
      name: input.name ?? existing.name,
      slug,
      description: input.description ?? existing.description,
      updatedAt: new Date(),
    })
    .where(eq(mockServices.id, id))
    .returning();

  if (!row) throw new MockError('not_found', 'Service not found');

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
  const service = await getServiceBySlug(orgId, slug);
  if (!service) return null;

  const cached = routerCache.get(service.id);
  if (cached) return cached;

  const definitions = await routeDefinitions(service.id);
  const router = buildServiceRouter(service.id, definitions);
  routerCache.set(service.id, router);

  return router;
}

export async function createRoute(
  orgId: string,
  serviceId: string,
  input: CreateMockRouteRequest,
): Promise<MockRouteSummary> {
  const service = await getServiceById(orgId, serviceId);
  if (!service) throw new MockError('not_found', 'Service not found');

  const path = input.path.trim();
  if (!path.startsWith('/')) {
    throw new MockError('invalid', 'A route path must start with "/"');
  }

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

  const [row] = await db
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

  if (!row) throw new MockError('invalid', 'Failed to create the route');

  invalidateRouterCache(serviceId);
  return toRouteSummary(row);
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

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
  const path = input.path?.trim() ?? route.path;

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
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
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
