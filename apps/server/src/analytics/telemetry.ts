import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { getServiceRouter } from '../mock/services.js';
import { recordRequestLog } from './ingest.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The mock service the request resolved to, once known. */
    mockServiceId: string | null;
    /**
     * Set by the real rate limiter when it rejects a request. A chaos
     * engine 429 is a simulation and must not be counted as throttling.
     */
    rateLimited: boolean;
    /** Set once a log row has been queued, so no request is logged twice. */
    telemetryRecorded: boolean;
  }
}

/**
 * Status codes for requests that never got an HTTP response, borrowed from
 * nginx: 444 means the server closed the connection on purpose (a chaos
 * partition drop), 499 means the client went away first.
 */
export const STATUS_CONNECTION_DROPPED = 444;
export const STATUS_CLIENT_CLOSED = 499;

/**
 * Queue one `request_logs` row for a mock API request.
 *
 * Fastify only runs `onResponse` when a response finishes, so requests that
 * end without one — a chaos socket drop, a client abort — used to vanish
 * from analytics. Those paths call this directly with a synthetic status.
 */
export async function recordMockRequest(
  request: FastifyRequest,
  reply: FastifyReply | null,
  statusCode: number,
): Promise<void> {
  const auth = request.keyAuth;
  if (!auth || request.telemetryRecorded) return;
  request.telemetryRecorded = true;

  let serviceId = request.mockServiceId;
  if (!serviceId) {
    const slug = (request.params as { serviceSlug?: string } | undefined)?.serviceSlug;
    if (slug) {
      try {
        serviceId = (await getServiceRouter(auth.orgId, slug))?.serviceId ?? null;
      } catch (err) {
        request.log.warn({ err }, 'Failed to resolve serviceId for telemetry');
      }
    }
  }

  const elapsed = reply ? reply.elapsedTime : performance.now() - requestStartedAt(request);

  recordRequestLog({
    keyId: auth.keyId,
    orgId: auth.orgId,
    serviceId,
    method: request.method.toUpperCase(),
    path: request.raw.url?.split('?')[0] ?? request.url,
    statusCode,
    latencyMs: Math.max(0, Math.round(elapsed)),
    rateLimited: request.rateLimited,
    traceId: String(request.id),
  });
}

/** Registers the request fields above on the root instance. */
export const telemetryPlugin = fp(async (fastify) => {
  fastify.decorateRequest('mockServiceId', null);
  fastify.decorateRequest('rateLimited', false);
  fastify.decorateRequest('telemetryRecorded', false);
});

const startTimes = new WeakMap<FastifyRequest, number>();

/** Remember when a request arrived, for requests that never get a reply. */
export function markRequestStart(request: FastifyRequest): void {
  startTimes.set(request, performance.now());
}

function requestStartedAt(request: FastifyRequest): number {
  return startTimes.get(request) ?? performance.now();
}
