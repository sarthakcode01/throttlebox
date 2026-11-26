import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  HTTP_METHODS,
  PLAYGROUND_EXPORT_FORMATS,
  type PlaygroundRequest,
  type PlaygroundRequestKind,
} from '@throttlebox/shared';
import { db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { redact } from '../keys/redact.js';
import {
  assertSessionHasRoom,
  createSession,
  deleteSession,
  getRequest,
  getSession,
  listRequests,
  listSessions,
  playgroundErrorStatus,
  PlaygroundError,
  recordRequest,
  renameSession,
} from '../playground/store.js';
import { runPlaygroundRequest, sanitizeRequestHeaders } from '../playground/runner.js';
import { toPostman } from '../playground/export/postman.js';
import { toVitest } from '../playground/export/vitest.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * The path is appended to `/mock/<slug>`, so it must stay inside that
 * prefix: no query or fragment smuggling, no traversal, no control chars.
 */
const pathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^\//, 'Path must start with "/"')
  .refine(
    (p) => !/[?#\\]/.test(p) && ![...p].some((c) => c.charCodeAt(0) < 0x20),
    'Path may not contain ?, #, backslashes or control characters',
  )
  .refine(
    (p) => !p.split('/').some((seg) => seg === '..' || seg === '.'),
    'Path may not contain dot segments',
  );

// zod 4 requires both the key and value schema. With one argument the value
// type becomes `unknown`, which silently widens every downstream type.
const stringRecord = (max: number) =>
  z
    .record(z.string(), z.string().max(2000))
    .refine((r) => Object.keys(r).length <= max, `At most ${max} entries`);

const sendSchema = z.object({
  keyId: z.string().uuid(),
  method: z.enum(HTTP_METHODS),
  serviceSlug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid service slug'),
  path: pathSchema,
  query: stringRecord(50).optional(),
  headers: stringRecord(50).optional(),
  body: z
    .string()
    .max(256 * 1024)
    .nullable()
    .optional(),
  parentId: z.string().uuid().optional(),
});

const replaySchema = z.object({ keyId: z.string().uuid().optional() });
const sessionNameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().datetime().optional(),
});
const exportQuerySchema = z.object({
  format: z.enum(PLAYGROUND_EXPORT_FORMATS).default('vitest'),
  ids: z.string().optional(),
  includeFaults: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

function signature(r: PlaygroundRequest): string {
  return JSON.stringify([r.method, r.serviceSlug, r.path, r.query, r.headers, r.body]);
}

function fileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'playground'
  );
}

export const playgroundRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.requireAuth(request, reply);
    if (reply.sent) return;
    if (!request.auth?.orgId) {
      return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
    }
  });

  const read = fastify.requirePermission('playground:read');
  const run = fastify.requirePermission('playground:run');

  /** Convert a store error into an HTTP response; rethrow anything unexpected. */
  function handle(err: unknown, reply: FastifyReply) {
    if (err instanceof PlaygroundError) {
      return reply
        .code(playgroundErrorStatus(err.code))
        .send({ error: err.code, message: err.message });
    }
    throw err;
  }

  // ---- Sessions ---------------------------------------------------------

  fastify.get('/playground/sessions', { preHandler: [read] }, async (request, reply) => {
    return reply.send({ sessions: await listSessions(request.auth!.orgId!) });
  });

  fastify.post('/playground/sessions', { preHandler: [run] }, async (request, reply) => {
    const parsed = sessionNameSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid session name' });
    }
    const session = await createSession(
      request.auth!.orgId!,
      request.auth!.userId,
      parsed.data.name,
    );
    return reply.code(201).send({ session });
  });

  fastify.patch('/playground/sessions/:id', { preHandler: [run] }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = sessionNameSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid input' });
    }
    try {
      return reply.send({
        session: await renameSession(request.auth!.orgId!, params.data.id, body.data.name),
      });
    } catch (err) {
      return handle(err, reply);
    }
  });

  fastify.delete('/playground/sessions/:id', { preHandler: [run] }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid session id' });
    }
    try {
      await deleteSession(request.auth!.orgId!, params.data.id);
      return reply.send({ success: true });
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---- History ----------------------------------------------------------

  fastify.get(
    '/playground/sessions/:id/requests',
    { preHandler: [read] },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const query = listQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid input' });
      }
      try {
        const requests = await listRequests(request.auth!.orgId!, params.data.id, query.data);
        return reply.send({ requests });
      } catch (err) {
        return handle(err, reply);
      }
    },
  );

  fastify.get('/playground/requests/:id', { preHandler: [read] }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid request id' });
    }
    try {
      return reply.send({ request: await getRequest(request.auth!.orgId!, params.data.id) });
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---- Send / replay ----------------------------------------------------

  /** A key may only be used if it belongs to the caller's organization. */
  async function assertKeyInOrg(orgId: string, keyId: string): Promise<void> {
    const [key] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
      .limit(1);
    if (!key) throw new PlaygroundError('not_found', 'API key not found');
  }

  async function execute(
    orgId: string,
    sessionId: string,
    kind: PlaygroundRequestKind,
    parentId: string | null,
    input: {
      keyId: string;
      method: (typeof HTTP_METHODS)[number];
      serviceSlug: string;
      path: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: string | null;
    },
  ): Promise<PlaygroundRequest> {
    await getSession(orgId, sessionId);
    await assertSessionHasRoom(sessionId);
    await assertKeyInOrg(orgId, input.keyId);

    const headers = sanitizeRequestHeaders(input.headers);
    const query = input.query ?? {};
    const body = input.body ? input.body : null;

    const result = await runPlaygroundRequest(fastify, {
      orgId,
      keyId: input.keyId,
      method: input.method,
      serviceSlug: input.serviceSlug,
      path: input.path,
      query,
      headers,
      body,
    });

    return recordRequest({
      orgId,
      sessionId,
      keyId: input.keyId,
      parentId,
      kind,
      method: input.method,
      serviceSlug: input.serviceSlug,
      path: input.path,
      query,
      headers,
      body: body === null ? null : redact(body),
      result,
    });
  }

  fastify.post('/playground/sessions/:id/send', { preHandler: [run] }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = sendSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: (body.success ? undefined : body.error.issues[0]?.message) ?? 'Invalid input',
      });
    }
    const orgId = request.auth!.orgId!;
    try {
      let parentId: string | null = null;
      if (body.data.parentId) {
        // Forking from a request in another org is a cross-tenant read: 404.
        parentId = (await getRequest(orgId, body.data.parentId)).id;
      }
      const result = await execute(
        orgId,
        params.data.id,
        parentId ? 'fork' : 'send',
        parentId,
        body.data,
      );
      return reply.code(201).send({ request: result });
    } catch (err) {
      return handle(err, reply);
    }
  });

  fastify.post('/playground/requests/:id/replay', { preHandler: [run] }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = replaySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid input' });
    }
    const orgId = request.auth!.orgId!;
    try {
      const original = await getRequest(orgId, params.data.id);
      const keyId = body.data.keyId ?? original.keyId;
      if (!keyId) {
        return reply.code(400).send({
          error: 'key_required',
          message: 'The original API key no longer exists. Choose a key to replay with.',
        });
      }
      const result = await execute(orgId, original.sessionId, 'replay', original.id, {
        keyId,
        method: original.method,
        serviceSlug: original.serviceSlug,
        path: original.path,
        query: original.query,
        headers: original.headers,
        body: original.body,
      });
      return reply.code(201).send({ request: result });
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---- Export -----------------------------------------------------------

  fastify.get('/playground/sessions/:id/export', { preHandler: [read] }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const query = exportQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid input' });
    }
    const orgId = request.auth!.orgId!;
    try {
      const session = await getSession(orgId, params.data.id);
      const ids = query.data.ids
        ? query.data.ids
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      if (ids && !ids.every((i) => z.string().uuid().safeParse(i).success)) {
        return reply.code(400).send({ error: 'validation_error', message: 'ids must be UUIDs' });
      }

      // Oldest first, so the file reads in the order things happened.
      let requests = (await listRequests(orgId, session.id, { limit: 200, ids })).reverse();

      if (!ids) {
        // Without an explicit selection, collapse repeated runs of the same
        // request to the most recent one.
        const latest = new Map<string, PlaygroundRequest>();
        for (const r of requests) latest.set(signature(r), r);
        requests = [...latest.values()];
      }

      // Prefer the configured public URL over the request's `Host` header.
      //
      // The header is attacker-influenced, and this value is written into a
      // generated test file that a developer then runs. Deriving it from the
      // request would let a spoofed `Host` point their test at someone else.
      const baseUrl = process.env.PUBLIC_API_URL ?? `${request.protocol}://${request.host}`;
      const slug = fileSlug(session.name);

      if (query.data.format === 'postman') {
        reply.header(
          'Content-Disposition',
          `attachment; filename="${slug}.postman_collection.json"`,
        );
        return reply
          .type('application/json')
          .send(toPostman(requests, { sessionName: session.name, baseUrl }));
      }

      reply.header('Content-Disposition', `attachment; filename="${slug}.test.ts"`);
      return reply.type('text/plain; charset=utf-8').send(
        toVitest(requests, {
          sessionName: session.name,
          baseUrl,
          includeFaults: query.data.includeFaults,
        }),
      );
    } catch (err) {
      return handle(err, reply);
    }
  });
};
