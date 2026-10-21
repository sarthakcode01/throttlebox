import Router from 'find-my-way';
import type { HttpMethod } from '@throttlebox/shared';

export interface RouteDefinition {
  id: string;
  method: HttpMethod;
  path: string;
  statusCode: number;
  responseTemplate: unknown;
  responseHeaders: Record<string, string>;
  latencyMs: number;
}

export interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
}

export interface ServiceRouter {
  serviceId: string;
  routes: RouteDefinition[];
  /**
   * Find the route that handles a request.
   *
   * `find-my-way` picks the most specific match, so `/products/:id` and
   * `/products/featured` can coexist. Returns null when nothing matches.
   */
  match(method: string, path: string): RouteMatch | null;
}

/**
 * Normalise a stored path.
 *
 * Routes are stored relative to the service, e.g. `/products/:id`. A leading
 * slash is required by the router, and a trailing slash is stripped so
 * `/products` and `/products/` are the same route.
 */
export function normalizePath(path: string): string {
  let normalized = path.trim();
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Build a router for one mock service.
 *
 * Each service gets its own `find-my-way` instance, so route tables are
 * independent: one org's routes can never shadow another's, and a single
 * service can be rebuilt without touching the rest.
 *
 * The route definition travels with the handler as find-my-way's `store`, so
 * a match returns the definition and the path parameters together.
 */
export function buildServiceRouter(serviceId: string, routes: RouteDefinition[]): ServiceRouter {
  const router = Router();
  const definitions: RouteDefinition[] = [];

  for (const route of routes) {
    const path = normalizePath(route.path);
    const definition: RouteDefinition = { ...route, path };
    definitions.push(definition);

    router.on(
      route.method,
      path,
      () => {
        // The matcher is what matters; the definition comes back via `store`.
      },
      definition,
    );
  }

  return {
    serviceId,
    routes: definitions,

    match(method, path) {
      const result = router.find(method.toUpperCase() as HttpMethod, normalizePath(path));
      if (!result) return null;

      const definition = result.store as RouteDefinition | undefined;
      if (!definition) return null;

      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(result.params ?? {})) {
        if (typeof value === 'string') params[key] = value;
      }

      return { route: definition, params };
    },
  };
}
