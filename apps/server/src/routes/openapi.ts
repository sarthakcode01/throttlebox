import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getServiceBySlug, listRoutes } from '../mock/services.js';
import { buildOpenApiDocument } from '../mock/openapi.js';
import { extractBearerKey } from '../keys/middleware.js';
import { verifyKey } from '../keys/verify.js';

/**
 * Resolve the organization the request belongs to.
 *
 * Either a dashboard session or an API key works. A developer pasting the
 * document into a client generator has an API key, not a browser session, so
 * requiring a session would make the document useless outside the dashboard.
 */
async function resolveOrgId(request: FastifyRequest): Promise<string | null> {
  if (request.auth?.orgId) return request.auth.orgId;

  const raw = extractBearerKey(request);
  if (!raw) return null;

  const context = await verifyKey(raw);
  return context?.orgId ?? null;
}

/**
 * The OpenAPI document for a mock service.
 *
 * It describes the shape of the API, not anybody's data.
 */
export const openApiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/docs/:serviceSlug/openapi.json', async (request, reply) => {
    const params = z.object({ serviceSlug: z.string().min(1).max(60) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid service slug' });
    }

    const orgId = await resolveOrgId(request);
    if (!orgId) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Sign in or use an API key to read the document' });
    }

    const service = await getServiceBySlug(orgId, params.data.serviceSlug);
    if (!service) {
      return reply.code(404).send({ error: 'not_found', message: 'Service not found' });
    }

    const routeRows = await listRoutes(orgId, service.id);
    const document = buildOpenApiDocument({
      serviceName: service.name,
      serviceSlug: service.slug,
      description: service.description,
      // `host` includes the port; `hostname` does not, which would produce a
      // base URL the reader cannot actually call.
      baseUrl: `${request.protocol}://${request.host}`,
      routes: routeRows
        .filter((route) => route.isActive)
        .map((route) => ({
          id: route.id,
          method: route.method,
          path: route.path,
          statusCode: route.statusCode,
          responseTemplate: route.responseTemplate,
          responseHeaders: route.responseHeaders,
          latencyMs: route.latencyMs,
        })),
    });

    return reply.send(document);
  });
};
