import type { PlaygroundRequest } from '@throttlebox/shared';
import { effectiveHeaders } from './headers.js';

/**
 * Postman Collection v2.1. The key and host are collection variables, so the
 * file holds no secret and works against any environment.
 */
export function toPostman(
  requests: PlaygroundRequest[],
  options: { sessionName: string; baseUrl: string },
): Record<string, unknown> {
  return {
    info: {
      name: options.sessionName,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: options.baseUrl },
      { key: 'apiKey', value: '' },
    ],
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{apiKey}}', type: 'string' }],
    },
    item: requests.map((r, i) => {
      const segments = ['mock', r.serviceSlug, ...r.path.split('/').filter(Boolean)];
      const query = Object.entries(r.query).map(([key, value]) => ({ key, value }));
      const qs = query.length ? `?${new URLSearchParams(r.query).toString()}` : '';
      return {
        name: `#${i + 1} ${r.method} ${r.path}`,
        request: {
          method: r.method,
          header: Object.entries(effectiveHeaders(r)).map(([key, value]) => ({ key, value })),
          url: {
            raw: `{{baseUrl}}/${segments.join('/')}${qs}`,
            host: ['{{baseUrl}}'],
            path: segments,
            ...(query.length ? { query } : {}),
          },
          ...(r.body
            ? { body: { mode: 'raw', raw: r.body, options: { raw: { language: 'json' } } } }
            : {}),
        },
      };
    }),
  };
}
