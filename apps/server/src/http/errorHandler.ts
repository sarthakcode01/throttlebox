import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { isProduction } from '../config.js';

/**
 * A single place where unexpected errors become responses.
 *
 * Fastify's default handler returns the error's own message, which for a
 * database error means the client sees the raw constraint name and the
 * statement that failed. That is a small information leak and a confusing
 * message, so unexpected errors are replaced with a generic one and the
 * detail goes to the log.
 */
export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    // Errors we raised deliberately carry a status code and are safe to show.
    const status = error.statusCode ?? 500;

    if (status < 500) {
      void reply.code(status).send({
        error: error.code ?? 'error',
        message: error.message,
      });
      return;
    }

    request.log.error({ err: error }, 'unhandled error');

    void reply.code(500).send({
      error: 'internal_error',
      // The detail is deliberately withheld outside development.
      message: isProduction ? 'Something went wrong' : error.message || 'Something went wrong',
    });
  });
}

/** Is this a validation error we should surface to the caller? */
export function isValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
