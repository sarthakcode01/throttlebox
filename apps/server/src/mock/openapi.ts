import type { HttpMethod } from '@throttlebox/shared';
import type { RouteDefinition } from './router.js';

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers: { url: string; description?: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
  };
}

/**
 * Extract the `:param` names from a path template.
 *
 * `/products/:id` yields `['id']`. A wildcard `*` is not a parameter.
 */
export function pathParameters(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment.startsWith(':') && segment.length > 1)
    .map((segment) => segment.slice(1).split('(')[0] as string)
    .filter((name) => name.length > 0);
}

/**
 * Build an OpenAPI 3.1 document for a mock service.
 *
 * The document describes the routes a developer would call, so it can be
 * pasted into their client, loaded into Postman, or used to generate a typed
 * SDK.
 */
export function buildOpenApiDocument(input: {
  serviceName: string;
  serviceSlug: string;
  description?: string;
  baseUrl: string;
  routes: RouteDefinition[];
}): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of input.routes) {
    const operation: Record<string, unknown> = {
      summary: route.path,
      operationId: `${route.method.toLowerCase()}${route.path.replace(/[^A-Za-z0-9]+/g, '_')}`,
      tags: [input.serviceSlug],
      responses: {
        [String(route.statusCode)]: {
          description: 'Mock response',
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
      },
    };

    const parameters = pathParameters(route.path);
    if (parameters.length > 0) {
      operation.parameters = parameters.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
        example: `example-${name}`,
      }));
    }

    if (route.responseHeaders && Object.keys(route.responseHeaders).length > 0) {
      const response = operation.responses as Record<string, Record<string, unknown>>;
      const target = response[String(route.statusCode)];
      if (target) {
        target.headers = Object.fromEntries(
          Object.entries(route.responseHeaders).map(([name, value]) => [
            name,
            { description: 'Fixed response header', schema: { type: 'string' }, example: value },
          ]),
        );
      }
    }

    const method = route.method.toLowerCase();
    paths[route.path] = { ...(paths[route.path] ?? {}), [method]: operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${input.serviceName} — mock API`,
      version: '1.0.0',
      ...(input.description ? { description: input.description } : {}),
    },
    servers: [{ url: `${input.baseUrl}/mock/${input.serviceSlug}`, description: 'Mock base URL' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Your API key, sent as `Authorization: Bearer <key>`',
        },
      },
    },
  };
}

/** Methods a document can carry, in the order OpenAPI conventionally lists them. */
export const OPENAPI_METHOD_ORDER: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
