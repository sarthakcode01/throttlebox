import type { FastifyInstance } from 'fastify';
import { PLAYGROUND_LIMITS, type HttpMethod, type PlaygroundOutcome } from '@throttlebox/shared';
import { redact } from '../keys/redact.js';
import { internalAuthHeaders } from './internalAuth.js';

/** 30s chaos latency cap + margin. A request still running after this is reported as an error. */
export const RUN_TIMEOUT_MS = 35_000;

/**
 * Headers a playground user may not set or see stored.
 *
 * Credentials are dropped on the way in (the runner supplies its own
 * authentication) and again on the way out, so a stored request can never
 * be used to recover a secret.
 */
const BLOCKED_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'x-csrf-token',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

const BLOCKED_RESPONSE_HEADERS = new Set(['set-cookie', 'authorization']);

export function sanitizeRequestHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase().trim();
    if (!lower || BLOCKED_REQUEST_HEADERS.has(lower) || lower.startsWith('x-throttlebox-'))
      continue;
    out[lower] = redact(String(value));
  }
  return out;
}

function sanitizeResponseHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || BLOCKED_RESPONSE_HEADERS.has(lower)) continue;
    out[lower] = redact(Array.isArray(value) ? value.join(', ') : String(value));
  }
  return out;
}

/** Cut text to a byte budget without splitting a multi-byte character. */
export function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Back up over UTF-8 continuation bytes (10xxxxxx).
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

export interface PlaygroundRunInput {
  orgId: string;
  keyId: string;
  method: HttpMethod;
  serviceSlug: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface PlaygroundRunResult {
  outcome: PlaygroundOutcome;
  status: number | null;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  durationMs: number;
}

/** Build the in-process URL. The caller has already validated the path shape. */
export function buildMockUrl(
  serviceSlug: string,
  path: string,
  query: Record<string, string> = {},
): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  const qs = new URLSearchParams(query).toString();
  return `/mock/${encodeURIComponent(serviceSlug)}${normalised}${qs ? `?${qs}` : ''}`;
}

/**
 * Run one request through the real mock pipeline — key auth, scope, rate
 * limit, chaos, handler, telemetry — in-process.
 *
 * Nothing here talks to the network, and the target is always
 * `/mock/<slug>/...` on this server, so there is no SSRF surface.
 */
export async function runPlaygroundRequest(
  fastify: FastifyInstance,
  input: PlaygroundRunInput,
  options: { timeoutMs?: number } = {},
): Promise<PlaygroundRunResult> {
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  const headers = sanitizeRequestHeaders(input.headers);

  const hasBody = input.body !== undefined && input.body !== null && input.body !== '';
  if (hasBody && !headers['content-type']) headers['content-type'] = 'application/json';

  const startedAt = performance.now();

  const injected = fastify.inject({
    method: input.method,
    url: buildMockUrl(input.serviceSlug, input.path, input.query),
    headers: {
      ...headers,
      ...internalAuthHeaders(input.keyId),
    },
    ...(hasBody ? { payload: input.body as string } : {}),
  });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const result = await Promise.race([injected, timeout]);
    const durationMs = Math.round(performance.now() - startedAt);

    if (result === 'timeout') {
      return {
        outcome: 'error',
        status: null,
        headers: {},
        body: JSON.stringify({ error: 'timeout', message: `No response within ${timeoutMs}ms` }),
        truncated: false,
        durationMs,
      };
    }

    const { text, truncated } = truncateToBytes(
      redact(result.body),
      PLAYGROUND_LIMITS.maxBodyBytes,
    );
    return {
      outcome: 'ok',
      status: result.statusCode,
      headers: sanitizeResponseHeaders(result.headers),
      body: text,
      truncated,
      durationMs,
    };
  } catch (err) {
    // A severed connection (the chaos "network partition" fault) surfaces here.
    const message = err instanceof Error ? err.message : String(err);
    return {
      outcome: 'dropped',
      status: null,
      headers: {},
      body: JSON.stringify({ error: 'connection_dropped', message }),
      truncated: false,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
