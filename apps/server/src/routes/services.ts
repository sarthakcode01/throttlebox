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

/** RFC 9110 `token`: what a header field name may contain. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Headers a mock route may not set. Framing headers corrupt the response;
 * `Set-Cookie` and the CORS and HSTS headers would let a mock act on the
 * API's own origin — including overwriting the dashboard session cookie.
 */
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'strict-transport-security',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const responseHeadersSchema = z
  .record(
    z
      .string()
      .max(200)
      // Control characters (CR/LF above all) make Node refuse the header,
      // which turned every request to the route into a 500.
      .refine(
        (value) =>
          [...value].every((char) => {
            const code = char.charCodeAt(0);
            // Tab is allowed; every other C0 control and DEL is not.
            return code === 0x09 || (code >= 0x20 && code !== 0x7f);
          }),
        'Header values cannot contain control characters',
      ),
  )
  .superRefine((headers, ctx) => {
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (!HEADER_NAME.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${name}" is not a valid header name`,
        });
      } else if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('access-control-')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `A mock route cannot set the "${name}" header`,
        });
      }
    }
  });

const routeSchema = z.object({
  method: z.enum(HTTP_METHODS),
  path: z.string().min(1).max(300).regex(/^\//, 'A route path must start with "/"'),
  summary: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  responseTemplate: z.unknown().optional(),
  responseHeaders: responseHeadersSchema.optional(),
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
