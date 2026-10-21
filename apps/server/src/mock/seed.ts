import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mockRoutes, mockServices } from '../db/schema.js';
import type { HttpMethod } from '@throttlebox/shared';

/**
 * The flagship mock service every new organization starts with.
 *
 * It exists so that a new user can generate a key and call something real
 * within a minute, without building anything first. It also serves as the
 * worked example of what the template engine can do.
 */

export const FLAGSHIP_SLUG = 'ecommerce';

interface SeedRoute {
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  statusCode: number;
  responseTemplate: unknown;
  responseHeaders?: Record<string, string>;
  latencyMs?: number;
  position: number;
}

const SEED_ROUTES: SeedRoute[] = [
  {
    method: 'GET',
    path: '/products',
    summary: 'List products',
    description: 'A paginated catalogue. Accepts `page` and `limit` query parameters.',
    statusCode: 200,
    position: 10,
    responseHeaders: { 'X-Total-Count': '42' },
    responseTemplate: {
      data: [
        {
          id: '{{faker.number.int min=1 max=10000}}',
          name: '{{faker.commerce.productName}}',
          description: '{{faker.commerce.productDescription}}',
          price: '{{faker.commerce.price}}',
          category: '{{faker.commerce.department}}',
          inStock: '{{faker.datatype.boolean}}',
          rating: '{{faker.number.float min=3 max=5 fractionDigits=1}}',
        },
        {
          id: '{{faker.number.int min=1 max=10000}}',
          name: '{{faker.commerce.productName}}',
          description: '{{faker.commerce.productDescription}}',
          price: '{{faker.commerce.price}}',
          category: '{{faker.commerce.department}}',
          inStock: '{{faker.datatype.boolean}}',
          rating: '{{faker.number.float min=3 max=5 fractionDigits=1}}',
        },
        {
          id: '{{faker.number.int min=1 max=10000}}',
          name: '{{faker.commerce.productName}}',
          description: '{{faker.commerce.productDescription}}',
          price: '{{faker.commerce.price}}',
          category: '{{faker.commerce.department}}',
          inStock: '{{faker.datatype.boolean}}',
          rating: '{{faker.number.float min=3 max=5 fractionDigits=1}}',
        },
      ],
      meta: {
        page: '{{query.page "1"}}',
        limit: '{{query.limit "20"}}',
        generatedAt: '{{now}}',
      },
    },
  },
  {
    method: 'GET',
    path: '/products/:id',
    summary: 'Get a product',
    description: 'A single product, looked up by id.',
    statusCode: 200,
    position: 20,
    responseTemplate: {
      id: '{{params.id}}',
      name: '{{faker.commerce.productName}}',
      description: '{{faker.commerce.productDescription}}',
      price: '{{faker.commerce.price}}',
      category: '{{faker.commerce.department}}',
      sku: '{{faker.string.alphanumeric 10}}',
      inStock: '{{faker.datatype.boolean}}',
      rating: '{{faker.number.float min=3 max=5 fractionDigits=1}}',
      reviews: [
        {
          id: '{{faker.string.uuid}}',
          author: '{{faker.person.fullName}}',
          rating: '{{faker.number.int min=3 max=5}}',
          body: '{{faker.lorem.sentence}}',
          createdAt: '{{now}}',
        },
        {
          id: '{{faker.string.uuid}}',
          author: '{{faker.person.fullName}}',
          rating: '{{faker.number.int min=3 max=5}}',
          body: '{{faker.lorem.sentence}}',
          createdAt: '{{now}}',
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/categories',
    summary: 'List categories',
    description: 'Every product category in the catalogue.',
    statusCode: 200,
    position: 30,
    responseTemplate: {
      data: [
        {
          id: 1,
          name: '{{faker.commerce.department}}',
          productCount: '{{faker.number.int min=5 max=80}}',
        },
        {
          id: 2,
          name: '{{faker.commerce.department}}',
          productCount: '{{faker.number.int min=5 max=80}}',
        },
        {
          id: 3,
          name: '{{faker.commerce.department}}',
          productCount: '{{faker.number.int min=5 max=80}}',
        },
        {
          id: 4,
          name: '{{faker.commerce.department}}',
          productCount: '{{faker.number.int min=5 max=80}}',
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/customers/:id',
    summary: 'Get a customer',
    description: 'A customer profile, looked up by id.',
    statusCode: 200,
    position: 40,
    responseTemplate: {
      id: '{{params.id}}',
      name: '{{faker.person.fullName}}',
      email: '{{faker.internet.email}}',
      phone: '{{faker.phone.number}}',
      address: {
        street: '{{faker.location.streetAddress}}',
        city: '{{faker.location.city}}',
        country: '{{faker.location.country}}',
        postcode: '{{faker.location.zipCode}}',
      },
      createdAt: '{{now}}',
    },
  },
  {
    method: 'POST',
    path: '/orders',
    summary: 'Create an order',
    description: 'Accepts a list of product ids and returns the created order.',
    statusCode: 201,
    position: 50,
    responseHeaders: { Location: '/mock/ecommerce/orders/{{params.id}}' },
    responseTemplate: {
      id: '{{faker.string.uuid}}',
      status: 'pending',
      customerId: '{{faker.number.int min=1 max=500}}',
      items: [
        {
          productId: '{{faker.number.int min=1 max=10000}}',
          quantity: '{{faker.number.int min=1 max=5}}',
          unitPrice: '{{faker.commerce.price}}',
        },
      ],
      total: '{{faker.commerce.price}}',
      createdAt: '{{now}}',
    },
  },
  {
    method: 'GET',
    path: '/orders/:id',
    summary: 'Get an order',
    description: 'An order, looked up by id.',
    statusCode: 200,
    position: 60,
    responseTemplate: {
      id: '{{params.id}}',
      status: 'shipped',
      items: [
        {
          productId: '{{faker.number.int min=1 max=10000}}',
          quantity: '{{faker.number.int min=1 max=5}}',
          unitPrice: '{{faker.commerce.price}}',
        },
      ],
      total: '{{faker.commerce.price}}',
      createdAt: '{{now}}',
    },
  },
  {
    method: 'GET',
    path: '/health',
    summary: 'Service health',
    description: 'A trivial endpoint for checking that the mock is reachable.',
    statusCode: 200,
    position: 70,
    responseTemplate: {
      status: 'ok',
      service: 'ecommerce',
      time: '{{now}}',
    },
  },
];

/**
 * Create the flagship service for an organization, if it does not have one
 * already.
 *
 * Safe to call more than once — a second call is a no-op.
 */
export async function seedFlagshipService(orgId: string): Promise<void> {
  const [existing] = await db
    .select({ id: mockServices.id })
    .from(mockServices)
    .where(and(eq(mockServices.orgId, orgId), eq(mockServices.slug, FLAGSHIP_SLUG)))
    .limit(1);

  if (existing) return;

  const [service] = await db
    .insert(mockServices)
    .values({
      orgId,
      name: 'E-commerce',
      slug: FLAGSHIP_SLUG,
      description:
        'A small storefront API: products, categories, customers, and orders. ' +
        'Use it to try things before you build your own.',
      isSeeded: true,
    })
    .returning({ id: mockServices.id });

  if (!service) return;

  await db.insert(mockRoutes).values(
    SEED_ROUTES.map((route) => ({
      serviceId: service.id,
      method: route.method,
      path: route.path,
      summary: route.summary,
      description: route.description,
      statusCode: route.statusCode,
      responseTemplate: route.responseTemplate,
      responseHeaders: route.responseHeaders ?? {},
      latencyMs: route.latencyMs ?? 0,
      position: route.position,
    })),
  );
}
