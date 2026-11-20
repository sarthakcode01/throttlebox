import type { PlaygroundRequest } from '@throttlebox/shared';

/**
 * The headers a request was actually sent with.
 *
 * The runner defaults `Content-Type` to JSON when a body is present and the
 * user set none. That default is applied at execution time and is not part
 * of the stored headers, so exporters must re-apply it — otherwise a client
 * such as `fetch` sends `text/plain`, the server does not parse the body, and
 * the exported test fails against the very response it was captured from.
 */
export function effectiveHeaders(r: Pick<PlaygroundRequest, 'headers' | 'body'>): Record<string, string> {
  const headers = { ...r.headers };
  if (r.body && !headers['content-type']) headers['content-type'] = 'application/json';
  return headers;
}
