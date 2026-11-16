import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  markRequestStart,
  recordMockRequest,
  STATUS_CLIENT_CLOSED,
} from '../analytics/telemetry.js';
import { getServiceRouter } from '../mock/services.js';
import {
  createTemplateContext,
  renderTemplate,
  safeStringify,
  seedFrom,
  type TemplateContext,
} from '../mock/template.js';

/**
 * The public mock API.
 *
 * A request looks like:
 *
 *   GET /mock/ecommerce/products/42
 *
 * The organization is not in the URL. It comes from the API key, which is
 * the tenant boundary — one key can only ever reach its own services, no
 * matter what the URL says.
 */

const MOCK_URL = '/mock/:serviceSlug/*';
/** The service root, `/mock/ecommerce`, which the wildcard route does not match. */
const MOCK_ROOT_URL = '/mock/:serviceSlug';

/**
 * Methods that only read.
 *
 * HEAD is not listed: Fastify generates it from the GET route automatically.
 */
const READ_METHODS = ['GET'] as const;
/** Methods that change something. */
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Request headers a template may never read.
 *
 * `{{headers.authorization}}` echoed the caller's API key into the response
 * body, and in the dashboard preview `{{headers.cookie}}` rendered the
 * signed-in user's httpOnly session token into JSON that page script could
 * read.
 */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-csrf-token',
  'x-api-key',
]);

function templateHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (SECRET_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value === 'string') headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(', ');
  }
  return headers;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MockHandlerOptions {
  /** The dashboard preview renders the same thing without an API key. */
  preview?: {
    orgId: string;
    serviceSlug: string;
    method: string;
    path: string;
    body: unknown;
  };
}

interface MockParams {
  serviceSlug: string;
  /** The path after the service slug, still percent-encoded. */
  remaining: string;
}

/**
 * Work out the path the caller asked for.
 *
 * The wildcard parameter is not used for the path itself. Fastify decodes
 * route parameters, and `find-my-way` would decode the path again on the
 * way in — so a value like `a%2520b` would be decoded twice and arrive as
 * `a b` instead of `a%20b`. A `%2F` was worse: it became a real slash, split
 * the path, and the route stopped matching at all.
 *
 * Taking the raw URL and letting `find-my-way` do the decoding means it
 * happens exactly once, and an encoded slash stays inside its parameter.
 */
function mockParams(request: FastifyRequest): MockParams {
  const params = request.params as (Partial<MockParams> & { '*'?: string }) | undefined;
  const serviceSlug = params?.serviceSlug ?? '';

  const rawUrl = request.raw.url ?? '';
  // `request.raw.url` is the path and query as they arrived. Strip the query
  // and, if the request line carried an absolute URL, the origin.
  let rawPath = rawUrl.split('?')[0] ?? '';
  const schemeEnd = rawPath.indexOf('://');
  if (schemeEnd !== -1) {
    const pathStart = rawPath.indexOf('/', schemeEnd + 3);
    rawPath = pathStart === -1 ? '/' : rawPath.slice(pathStart);
  }

  const prefix = `/mock/${serviceSlug}`;
  const remaining = rawPath.startsWith(prefix)
    ? rawPath.slice(prefix.length)
    : (params?.['*'] ?? '');

  return { serviceSlug, remaining: remaining || '/' };
}

/** Plain string query parameters, from a parsed query object. */
function stringQuery(raw: unknown): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string') query[key] = value;
  }
  return query;
}

/**
 * A canonical query string for the seed: sorted, so `?a=1&b=2` and
 * `?b=2&a=1` are the same resource. Empty when there is no query, so a
 * request without one keeps the seed it always had.
 */
function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${key}=${query[key]}`)
    .join('&');
}

/** Render header values as templates, so `Location: /orders/{{params.id}}` works. */
function renderHeaders(
  headers: Record<string, string>,
  context: TemplateContext,
): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const output = renderTemplate(value, context);
    if (output === undefined || output === null) continue;
    rendered[name] = typeof output === 'object' ? JSON.stringify(output) : String(output);
  }
  return rendered;
}

/**
 * Render a mock response.
 *
 * Shared by the public endpoint and the dashboard preview, so what the
 * preview shows is exactly what a caller would receive.
 */
async function renderMockResponse(
  request: FastifyRequest,
  options: MockHandlerOptions,
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  matched: string | null;
  latencyMs: number;
}> {
  const auth = options.preview
    ? { orgId: options.preview.orgId }
    : { orgId: request.keyAuth!.orgId };

  const params = mockParams(request);
  const serviceSlug = options.preview ? options.preview.serviceSlug : params.serviceSlug;

  // The preview takes the query string as part of the path it is given.
  let remaining = options.preview ? options.preview.path : params.remaining;
  let query = stringQuery(request.query);
  if (options.preview) {
    const [pathPart, queryPart] = remaining.split('?', 2);
    remaining = pathPart ?? '/';
    query = queryPart ? Object.fromEntries(new URLSearchParams(queryPart)) : {};
  }

  const router = await getServiceRouter(auth.orgId, serviceSlug);
  if (!router) {
    return {
      statusCode: 404,
      headers: {},
      body: safeStringify({
        error: 'service_not_found',
        message: `No mock service "${serviceSlug}"`,
      }),
      matched: null,
      latencyMs: 0,
    };
  }

  request.mockServiceId = router.serviceId;

  const method = (options.preview ? options.preview.method : request.method).toUpperCase();
  const path = remaining.startsWith('/') ? remaining : `/${remaining}`;

  const match = router.match(method, path);
  if (!match) {
    const available = router.routes
      .map((route) => `${route.method} ${route.path}`)
      .sort()
      .join(', ');

    return {
      statusCode: 404,
      headers: {},
      body: safeStringify({
        error: 'route_not_found',
        message: `${method} ${path} does not match any route on "${serviceSlug}"`,
        availableRoutes: available ? available.split(', ') : [],
      }),
      matched: null,
      latencyMs: 0,
    };
  }

  const queryKey = canonicalQuery(query);
  const context = createTemplateContext({
    params: match.params,
    query,
    body: options.preview ? options.preview.body : request.body,
    headers: templateHeaders(request),
    // Deterministic, and scoped to the *organization* rather than the key.
    //
    // The mock data belongs to the service, not to the credential: two keys
    // in the same organization must see the same product, or "the same
    // resource" would change depending on which key called it. Scoping by
    // organization also means the dashboard preview renders exactly what a
    // caller receives, because both sides derive the same seed.
    //
    // The query string is part of the resource: `?page=2` used to return
    // exactly the same products as page 1.
    seed: queryKey
      ? seedFrom(auth.orgId, serviceSlug, method, path, queryKey)
      : seedFrom(auth.orgId, serviceSlug, method, path),
  });

  const rendered = renderTemplate(match.route.responseTemplate, context);
  const body = safeStringify(rendered);

  return {
    statusCode: match.route.statusCode,
    headers: renderHeaders(match.route.responseHeaders ?? {}, context),
    body,
    matched: `${match.route.method} ${match.route.path}`,
    latencyMs: match.route.latencyMs,
  };
}

export const mockRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request) => {
    markRequestStart(request);
  });

  fastify.addHook('onResponse', async (request, reply) => {
    try {
      if (!request.keyAuth) {
        if (reply.statusCode === 401) {
          request.log.warn(
            {
              method: request.method,
              url: request.raw.url,
              statusCode: reply.statusCode,
              ip: request.ip,
            },
            'Unauthenticated mock request attempt (401)',
          );
        }
        return;
      }

      await recordMockRequest(request, reply, reply.statusCode);
    } catch (err) {
      request.log.warn({ err }, 'Unexpected error in onResponse telemetry hook');
    }
  });

  // A client that hangs up before the response is sent never reaches
  // `onResponse`, so without this it was missing from analytics entirely.
  fastify.addHook('onRequestAbort', async (request) => {
    try {
      await recordMockRequest(request, null, STATUS_CLIENT_CLOSED);
    } catch (err) {
      request.log.warn({ err }, 'Failed to record aborted mock request');
    }
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await renderMockResponse(request, {});

    let hasContentType = false;
    for (const [name, value] of Object.entries(result.headers)) {
      try {
        reply.header(name, value);
        if (name.toLowerCase() === 'content-type') hasContentType = true;
      } catch (err) {
        // A header stored before validation existed: skip it rather than
        // failing the whole response.
        request.log.warn({ err, header: name }, 'Skipping invalid mock response header');
      }
    }

    if (result.latencyMs > 0) {
      await sleep(result.latencyMs);
    }

    // A route that declares its own Content-Type keeps it.
    if (!hasContentType) reply.type('application/json');
    return reply.code(result.statusCode).send(result.body);
  };

  const pipeline = (scope: 'mock:read' | 'mock:write') => [
    fastify.requireKeyAuth,
    fastify.requireScope(scope),
    fastify.rateLimitMock,
    fastify.chaosEngine,
  ];

  for (const method of READ_METHODS) {
    for (const url of [MOCK_URL, MOCK_ROOT_URL]) {
      fastify.route({ method, url, preHandler: pipeline('mock:read'), handler });
    }
  }

  for (const method of WRITE_METHODS) {
    for (const url of [MOCK_URL, MOCK_ROOT_URL]) {
      fastify.route({ method, url, preHandler: pipeline('mock:write'), handler });
    }
  }
};

/**
 * The dashboard preview.
 *
 * Same rendering path as the public endpoint, but authenticated with the
 * session instead of an API key, so the author of a mock can see exactly
 * what a caller would receive.
 */
export const mockPreviewRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const previewSchema = z.object({
    serviceSlug: z.string().min(1).max(60),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    path: z.string().min(1).max(500),
    body: z.unknown().optional(),
  });

  fastify.post(
    '/mock/preview',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('mock:read')] },
    async (request, reply) => {
      const parsed = previewSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid input',
        });
      }

      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      const result = await renderMockResponse(request, {
        preview: {
          orgId: auth.orgId,
          serviceSlug: parsed.data.serviceSlug,
          method: parsed.data.method,
          path: parsed.data.path,
          body: parsed.data.body ?? null,
        },
      });

      return reply.send({
        statusCode: result.statusCode,
        headers: result.headers,
        body: result.body,
        matchedRoute: result.matched,
        latencyMs: result.latencyMs,
      });
    },
  );
};
