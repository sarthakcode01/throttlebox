import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getServiceRouter } from '../mock/services.js';
import {
  createTemplateContext,
  renderTemplate,
  safeStringify,
  seedFrom,
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

/**
 * Methods that only read.
 *
 * HEAD is not listed: Fastify generates it from the GET route automatically.
 */
const READ_METHODS = ['GET'] as const;
/** Methods that change something. */
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

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
  const remaining = options.preview ? options.preview.path : params.remaining;

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

  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (typeof value === 'string') query[key] = value;
  }

  const context = createTemplateContext({
    params: match.params,
    query,
    body: options.preview ? options.preview.body : request.body,
    headers: request.headers as Record<string, string>,
    // Deterministic, and scoped to the *organization* rather than the key.
    //
    // The mock data belongs to the service, not to the credential: two keys
    // in the same organization must see the same product, or "the same
    // resource" would change depending on which key called it. Scoping by
    // organization also means the dashboard preview renders exactly what a
    // caller receives, because both sides derive the same seed.
    seed: seedFrom(auth.orgId, serviceSlug, method, path),
  });

  const rendered = renderTemplate(match.route.responseTemplate, context);
  const body = safeStringify(rendered);

  return {
    statusCode: match.route.statusCode,
    headers: match.route.responseHeaders ?? {},
    body,
    matched: `${match.route.method} ${match.route.path}`,
    latencyMs: match.route.latencyMs,
  };
}

export const mockRoutes: FastifyPluginAsync = async (fastify) => {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await renderMockResponse(request, {});

    for (const [name, value] of Object.entries(result.headers)) {
      reply.header(name, value);
    }

    if (result.latencyMs > 0) {
      await sleep(result.latencyMs);
    }

    return reply.code(result.statusCode).type('application/json').send(result.body);
  };

  for (const method of READ_METHODS) {
    fastify.route({
      method,
      url: MOCK_URL,
      preHandler: [fastify.requireKeyAuth, fastify.requireScope('mock:read')],
      handler,
    });
  }

  for (const method of WRITE_METHODS) {
    fastify.route({
      method,
      url: MOCK_URL,
      preHandler: [fastify.requireKeyAuth, fastify.requireScope('mock:write')],
      handler,
    });
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
