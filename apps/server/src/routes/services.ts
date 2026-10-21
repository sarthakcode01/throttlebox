import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HTTP_METHODS } from '@throttlebox/shared';
import {
  createRoute,
  createService,
  deleteRoute,
  deleteService,
  listRoutes,
  listServices,
  MockError,
  updateRoute,
  updateService,
} from '../mock/services.js';

const serviceSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(40).optional(),
  description: z.string().max(500).optional(),
});

const routeSchema = z.object({
  method: z.enum(HTTP_METHODS),
  path: z.string().min(1).max(300).regex(/^\//, 'A route path must start with "/"'),
  summary: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  responseTemplate: z.unknown().optional(),
  responseHeaders: z.record(z.string().max(200)).optional(),
  latencyMs: z.number().int().min(0).max(30_000).optional(),
  isActive: z.boolean().optional(),
});

const idSchema = z.object({ id: z.string().uuid() });

function mockErrorStatus(code: MockError['code']): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'duplicate':
      return 409;
    default:
      return 400;
  }
}

export const serviceRoutes: FastifyPluginAsync = async (fastify) => {
  // ---- Services --------------------------------------------------------

  fastify.get(
    '/mock/services',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('mock:read')] },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      const services = await listServices(auth.orgId);
      return reply.send({ services });
    },
  );

  fastify.post(
    '/mock/services',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('mock:create')] },
    async (request, reply) => {
      const parsed = serviceSchema.safeParse(request.body);
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

      try {
        const service = await createService(auth.orgId, parsed.data);
        return reply.code(201).send({ service });
      } catch (err) {
        if (err instanceof MockError) {
          return reply
            .code(mockErrorStatus(err.code))
            .send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  fastify.patch(
    '/mock/services/:id',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('mock:write')] },
    async (request, reply) => {
      const params = idSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid service id' });
      }

      const parsed = serviceSchema.partial().safeParse(request.body);
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

      try {
        const service = await updateService(auth.orgId, params.data.id, parsed.data);
        return reply.send({ service });
      } catch (err) {
        if (err instanceof MockError) {
          return reply
            .code(mockErrorStatus(err.code))
            .send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  fastify.delete(
    '/mock/services/:id',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('mock:delete')] },
    async (request, reply) => {
      const params = idSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid service id' });
      }

      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      try {
        await deleteService(auth.orgId, params.data.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof MockError) {
          return reply
            .code(mockErrorStatus(err.code))
            .send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // ---- Routes ----------------------------------------------------------

  fastify.get(
    '/mock/services/:id/routes',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('mock:read')] },
    async (request, reply) => {
      const params = idSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid service id' });
      }

      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      const routes = await listRoutes(auth.orgId, params.data.id);
      return reply.send({ routes });
    },
  );

  fastify.post(
    '/mock/services/:id/routes',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('mock:write')] },
    async (request, reply) => {
      const params = idSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid service id' });
      }

      const parsed = routeSchema.safeParse(request.body);
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

      try {
        const route = await createRoute(auth.orgId, params.data.id, parsed.data);
        return reply.code(201).send({ route });
      } catch (err) {
        if (err instanceof MockError) {
          return reply
            .code(mockErrorStatus(err.code))
            .send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  fastify.patch(
    '/mock/routes/:id',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('mock:write')] },
    async (request, reply) => {
      const params = idSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid route id' });
      }

      const parsed = routeSchema.partial().safeParse(request.body);
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

      try {
        const route = await updateRoute(auth.orgId, params.data.id, parsed.data);
        return reply.send({ route });
      } catch (err) {
        if (err instanceof MockError) {
          return reply
            .code(mockErrorStatus(err.code))
            .send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  fastify.delete(
    '/mock/routes/:id',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('mock:delete')] },
    async (request, reply) => {
      const params = idSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid route id' });
      }

      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      try {
        await deleteRoute(auth.orgId, params.data.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof MockError) {
          return reply
            .code(mockErrorStatus(err.code))
            .send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
};
