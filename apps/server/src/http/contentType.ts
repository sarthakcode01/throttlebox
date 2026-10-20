import type { FastifyInstance } from 'fastify';

/**
 * Register a catch-all content type parser.
 *
 * Fastify's default parsers handle `application/json` and `text/plain`. Any
 * other content type — including the `application/x-www-form-urlencoded` that
 * form-style clients send — gets a 415 before the route handler ever runs.
 *
 * That breaks bodyless POSTs. `POST /api/keys/:id/revoke` has no body to
 * parse, so a client that sets a content type anyway would get a confusing
 * "Unsupported Media Type" instead of a 204.
 *
 * The catch-all therefore accepts an empty body for any media type, and still
 * rejects a non-empty one with an unsupported type — we do not want to
 * silently accept an XML payload as if it were nothing.
 */
export function registerLenientContentType(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(
    '*',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_req, body, done) => {
      if (!body || body.length === 0) {
        done(null, undefined);
        return;
      }

      const error = new Error('Unsupported Media Type') as Error & { statusCode: number };
      error.statusCode = 415;
      done(error, undefined);
    },
  );
}
