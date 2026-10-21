import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { KEY_ENVS, KEY_SCOPES } from '@throttlebox/shared';
import {
  createKey,
  getKey,
  KeyStoreError,
  listKeys,
  revokeFamily,
  revokeKey,
  rotateKey,
} from '../keys/store.js';
import { redact } from '../keys/redact.js';

const createKeySchema = z.object({
  name: z.string().min(1).max(80),
  env: z.enum(KEY_ENVS).default('test'),
  scopes: z.array(z.enum(KEY_SCOPES)).max(KEY_SCOPES.length).optional(),
  expiresInDays: z.number().int().min(1).max(365).nullish(),
});

const rotateKeySchema = z.object({
  graceHours: z.number().int().min(0).max(720).optional(),
  scopes: z.array(z.enum(KEY_SCOPES)).max(KEY_SCOPES.length).optional(),
});

const paramsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Map a store error onto an HTTP status.
 *
 * `not_found` is a 404. `already_revoked` and `duplicate_idempotency_key` are
 * conflicts — the request was well formed but conflicts with the current
 * state. Everything else is a bad request.
 */
function keyErrorStatus(code: KeyStoreError['code']): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'already_revoked':
    case 'duplicate_idempotency_key':
      return 409;
    default:
      return 400;
  }
}

/**
 * The raw key is returned by exactly two endpoints — create and rotate — and
 * is never retrievable afterwards. Every other response is masked.
 */
export const keyRoutes: FastifyPluginAsync = async (fastify) => {
  // ---- Create ---------------------------------------------------------
  fastify.post(
    '/keys',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('keys:create')] },
    async (request, reply) => {
      const parsed = createKeySchema.safeParse(request.body ?? {});
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

      // The header is optional, but when present it makes a retried create
      // safe instead of minting a second key.
      const rawIdempotencyKey = request.headers['idempotency-key'];
      const idempotencyKey =
        typeof rawIdempotencyKey === 'string' && rawIdempotencyKey.length > 0
          ? rawIdempotencyKey.slice(0, 200)
          : null;

      try {
        const created = await createKey({
          orgId: auth.orgId,
          name: parsed.data.name,
          env: parsed.data.env,
          scopes: parsed.data.scopes,
          expiresInDays: parsed.data.expiresInDays ?? null,
          idempotencyKey,
          createdBy: auth.userId,
          actorUserId: auth.userId,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });

        return reply.code(201).send({
          id: created.id,
          familyId: created.familyId,
          key: created.key,
          prefix: created.prefix,
          last4: created.last4,
          env: created.env,
          scopes: created.scopes,
          expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
          warning: 'This is the only time the key will be shown.',
        });
      } catch (err) {
        if (err instanceof KeyStoreError) {
          return reply
            .code(keyErrorStatus(err.code))
            .send({ error: err.code, message: redact(err.message) });
        }
        throw err;
      }
    },
  );

  // ---- List -----------------------------------------------------------
  fastify.get(
    '/keys',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('keys:read')] },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      const keys = await listKeys(auth.orgId);
      return reply.send({ keys });
    },
  );

  // ---- Get one --------------------------------------------------------
  fastify.get(
    '/keys/:id',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('keys:read')] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid key id' });
      }

      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      const key = await getKey(auth.orgId, params.data.id);
      if (!key) {
        return reply.code(404).send({ error: 'not_found', message: 'API key not found' });
      }

      return reply.send(key);
    },
  );

  // ---- Rotate ---------------------------------------------------------
  fastify.post(
    '/keys/:id/rotate',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('keys:rotate')] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid key id' });
      }

      const parsed = rotateKeySchema.safeParse(request.body ?? {});
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
        const rotated = await rotateKey({
          orgId: auth.orgId,
          keyId: params.data.id,
          graceHours: parsed.data.graceHours,
          scopes: parsed.data.scopes,
          actorUserId: auth.userId,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });

        return reply.code(201).send({
          id: rotated.id,
          familyId: rotated.familyId,
          key: rotated.key,
          prefix: rotated.prefix,
          last4: rotated.last4,
          env: rotated.env,
          scopes: rotated.scopes,
          expiresAt: rotated.expiresAt ? rotated.expiresAt.toISOString() : null,
          warning: 'This is the only time the key will be shown.',
        });
      } catch (err) {
        if (err instanceof KeyStoreError) {
          return reply
            .code(keyErrorStatus(err.code))
            .send({ error: err.code, message: redact(err.message) });
        }
        throw err;
      }
    },
  );

  // ---- Revoke one -----------------------------------------------------
  fastify.post(
    '/keys/:id/revoke',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('keys:revoke')] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid key id' });
      }

      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      try {
        await revokeKey(auth.orgId, params.data.id, {
          actorUserId: auth.userId,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
      } catch (err) {
        if (err instanceof KeyStoreError) {
          return reply
            .code(keyErrorStatus(err.code))
            .send({ error: err.code, message: redact(err.message) });
        }
        throw err;
      }

      return reply.code(204).send();
    },
  );

  // ---- Revoke a family (kill switch) ----------------------------------
  fastify.post(
    '/families/:id/revoke',
    { preHandler: [fastify.requireAuth, fastify.requirePermission('keys:revoke')] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'validation_error', message: 'Invalid family id' });
      }

      const auth = request.auth;
      if (!auth?.orgId) {
        return reply.code(403).send({ error: 'forbidden', message: 'No organization membership' });
      }

      try {
        await revokeFamily(auth.orgId, params.data.id, {
          actorUserId: auth.userId,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
      } catch (err) {
        if (err instanceof KeyStoreError) {
          return reply
            .code(keyErrorStatus(err.code))
            .send({ error: err.code, message: redact(err.message) });
        }
        throw err;
      }

      return reply.code(204).send();
    },
  );
};
