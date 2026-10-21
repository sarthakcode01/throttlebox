import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getServiceBySlug, listRoutes } from '../mock/services.js';
import { buildOpenApiDocument } from '../mock/openapi.js';

/**
 * The OpenAPI document for a mock service.
 *
 * Public, because a developer is expected to paste it into their own tools.
 * The document describes the shape of the API, not anybody's data.
 */
export const openApiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/docs/:serviceSlug/openapi.json', async (request, reply) => {
    const params = z.object({ serviceSlug: z.string().min(1).max(60) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid service slug' });
    }

    const auth = request.auth;
    if (!auth?.orgId) {
      return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
    }

    const service = await getServiceBySlug(auth.orgId, params.data.serviceSlug);
    if (!service) {
      return reply.code(404).send({ error: 'not_found', message: 'Service not found' });
    }

    const routeRows = await listRoutes(auth.orgId, service.id);
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
