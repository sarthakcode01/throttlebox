import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { isProduction } from '../config.js';

/**
 * A single place where unexpected errors become responses.
 *
 * Fastify's default handler returns the error's own message, which for a
 * database error means the client sees the raw constraint name and the
 * statement that failed. That is a small information leak and a confusing
 * message, so unexpected errors are replaced with a generic one and the detail
 * goes to the log.
 *
 * Deliberate 4xx errors are echoed, but only when they opt in by marking
 * themselves safe. The previous rule was "every status below 500 is safe to
 * show", which is not a property of the status code — the first handler to
 * `throw Object.assign(new Error(sqlText), { statusCode: 400 })` would have
 * leaked the statement. `safeError()` is the opt-in.
 */

const SAFE_ERROR = Symbol.for('throttlebox.safeError');

export interface SafeError extends Error {
  statusCode: number;
  code?: string;
  [SAFE_ERROR]?: true;
}

/**
 * Build an error whose message is safe to return to the client.
 *
 * Use this for anything the caller can act on (validation, conflicts, quota
 * limits). Never use it around a database or filesystem message.
 */
export function safeError(statusCode: number, message: string, code?: string): SafeError {
  const error = new Error(message) as SafeError;
  error.statusCode = statusCode;
  error[SAFE_ERROR] = true;
  if (code) error.code = code;
  return error;
}

function isSafeError(error: unknown): error is SafeError {
  return typeof error === 'object' && error !== null && (error as SafeError)[SAFE_ERROR] === true;
}

/**
 * Errors raised by Fastify itself for a bad request are about the request, not
 * about our internals, so their message is safe. This is a fixed set rather
 * than "anything under 500".
 */
const SAFE_FASTIFY_CODES = new Set([
  'FST_ERR_CTP_INVALID_MEDIA_TYPE',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_BAD_URL',
  'FST_ERR_VALIDATION',
]);

export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    // Zod errors are always about the caller's input.
    if (error instanceof ZodError) {
      void reply.code(400).send({
        error: 'validation_error',
        message: error.issues[0]?.message ?? 'Invalid input',
      });
      return;
    }

    // An explicit, reviewed error from our own code.
    if (isSafeError(error)) {
      void reply.code(error.statusCode).send({
        error: error.code ?? 'error',
        message: error.message,
      });
      return;
    }

    // A request-shaped error raised by Fastify.
    if (status < 500 && error.code && SAFE_FASTIFY_CODES.has(error.code)) {
      void reply.code(status).send({ error: error.code, message: error.message });
      return;
    }

    // Anything else below 500 is still an unexpected path: log it and return a
    // generic body rather than trusting whatever message it happens to carry.
    if (status < 500) {
      request.log.warn({ err: error }, 'unexpected client error');
      void reply.code(status).send({
        error: error.code ?? 'error',
        message: 'The request could not be processed',
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
