import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  HTTP_METHODS,
  KEY_ENVS,
  KEY_STATUSES,
  PLANS,
  PLAYGROUND_OUTCOMES,
  PLAYGROUND_REQUEST_KINDS,
  ROLES,
} from '@throttlebox/shared';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ROLES);
export const planEnum = pgEnum('plan', PLANS);
export const keyEnvEnum = pgEnum('key_env', KEY_ENVS);
export const keyStatusEnum = pgEnum('key_status', KEY_STATUSES);
export const httpMethodEnum = pgEnum('http_method', HTTP_METHODS);

// ---------------------------------------------------------------------------
// Plans (Phase 4)
// ---------------------------------------------------------------------------

export const plans = pgTable('plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  requestsPerWindow: integer('requests_per_window').notNull(),
  windowSeconds: integer('window_seconds').notNull(),
  burstAllowance: numeric('burst_allowance', { precision: 3, scale: 2 }).notNull().default('1.00'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  // Case-insensitive uniqueness without requiring the citext extension.
  (table) => [uniqueIndex('users_email_lower').on(sql`lower(${table.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 of the session token. The raw token only ever lives in the cookie.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    uniqueIndex('sessions_token_hash').on(table.tokenHash),
    index('sessions_user_id').on(table.userId),
    index('sessions_expires_at').on(table.expiresAt),
  ],
);

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  plan: planEnum('plan').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('org_members_org_user').on(table.orgId, table.userId),
    index('org_members_user_id').on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// API keys (Phase 2)
// ---------------------------------------------------------------------------

/**
 * A rotation group. Revoking a family kills every key in it at once — the
 * kill switch for a suspected compromise.
 */
export const apiKeyFamilies = pgTable(
  'api_key_families',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Stable across rotations, e.g. "staging-backend". */
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('api_key_families_org_idx').on(table.orgId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => apiKeyFamilies.id, { onDelete: 'cascade' }),

    /** User-facing label. Mutable. */
    name: text('name').notNull(),
    /** Indexed lookup handle. Not a credential on its own. */
    publicId: text('public_id').notNull(),
    /** Display only: "sk_live_9Kd2mQxR7tYb". */
    prefix: text('prefix').notNull(),
    /** HMAC-SHA-256(pepper, publicId:secret). Never the raw secret. */
    secretHash: text('secret_hash').notNull(),
    /** Display only: last 4 characters of the secret. */
    last4: text('last4').notNull(),

    env: keyEnvEnum('env').notNull().default('test'),
    // `.array()` has to come first — the builder resets the other modifiers.
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: keyStatusEnum('status').notNull().default('active'),

    /**
     * Client-supplied idempotency token for key creation. The raw key cannot be
     * replayed on a retry (it is only ever shown once), so a duplicate
     * request is rejected rather than silently minting a second key.
     */
    idempotencyKey: text('idempotency_key'),

    /** Null means it never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Set during rotation: the old key stays valid until this moment. */
    graceUntil: timestamp('grace_until', { withTimezone: true }),
    rotatedFrom: uuid('rotated_from').references((): AnyPgColumn => apiKeys.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    // The lookup index. Everything else hangs off it.
    uniqueIndex('api_keys_public_id_uniq').on(table.publicId),
    index('api_keys_org_idx').on(table.orgId, table.createdAt),
    index('api_keys_family_idx').on(table.familyId),
    // One key per idempotency token per org. Postgres allows repeated NULLs,
    // so keys created without a token never collide.
    uniqueIndex('api_keys_idempotency_uniq').on(table.orgId, table.idempotencyKey),
  ],
);

/**
 * Append-only security audit trail. Every lifecycle event lands here, including
 * failed authentication attempts.
 */
export const apiKeyEvents = pgTable(
  'api_key_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    keyId: uuid('key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    familyId: uuid('family_id'),
    // Deliberately not a foreign key. The audit trail is meant to outlive the
    // objects it describes — if an org is deleted, the record of what its keys
    // did stays. The cost is that deleting an org leaves orphan rows, which
    // a retention job has to sweep.
    orgId: uuid('org_id').notNull(),
    /** Null means the key itself was the actor (a failed auth attempt). */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** created | rotated | revoked | auth_failed | expired | family_revoked */
    event: text('event').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('api_key_events_org_idx').on(table.orgId, table.createdAt),
    index('api_key_events_key_idx').on(table.keyId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Mock API engine (Phase 3)
// ---------------------------------------------------------------------------

/**
 * A mock API. One service is a coherent backend — "E-commerce", "Weather",
 * "Payments" — exposed under a single slug.
 */
export const mockServices = pgTable(
  'mock_services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** URL segment. Unique per org. */
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    /**
     * Seeded services cannot be deleted, only hidden. Every new org gets the
     * flagship E-commerce service so there is something to call immediately.
     */
    isSeeded: boolean('is_seeded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mock_services_org_slug_uniq').on(table.orgId, table.slug),
    index('mock_services_org_idx').on(table.orgId),
  ],
);

/**
 * One endpoint of a mock API.
 *
 * `response_template` is a JSON document that may contain `{{...}}`
 * expressions — see `mock/template.ts`. It is rendered with a declarative
 * resolver; there is no `eval` anywhere in the path.
 */
export const mockRoutes = pgTable(
  'mock_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => mockServices.id, { onDelete: 'cascade' }),

    method: httpMethodEnum('method').notNull(),
    /** Path template relative to the service, e.g. `/products/:id`. */
    path: text('path').notNull(),

    summary: text('summary').notNull().default(''),
    description: text('description').notNull().default(''),
    statusCode: integer('status_code').notNull().default(200),

    /** The rendered body. JSON, so arrays and objects work. */
    responseTemplate: jsonb('response_template')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Extra response headers, e.g. `{"X-Total-Count": "42"}`. */
    responseHeaders: jsonb('response_headers')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Artificial latency, in milliseconds. */
    latencyMs: integer('latency_ms').notNull().default(0),

    /**
     * Alternative responses with weights, used by the chaos controls in
     * Phase 6. Reserved here so adding it later is not a migration.
     */
    weightedResponses: jsonb('weighted_responses'),

    isActive: boolean('is_active').notNull().default(true),
    /** Ordering in the generated OpenAPI document. */
    position: integer('position').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('mock_routes_service_idx').on(table.serviceId),
    uniqueIndex('mock_routes_service_method_path_uniq').on(
      table.serviceId,
      table.method,
      table.path,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Telemetry & Logging (Phase 5)
// ---------------------------------------------------------------------------

export const requestLogs = pgTable(
  'request_logs',
  {
    time: timestamp('time', { withTimezone: true }).notNull().defaultNow(),
    keyId: uuid('key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').references(() => mockServices.id, { onDelete: 'set null' }),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    rateLimited: boolean('rate_limited').notNull().default(false),
    traceId: text('trace_id').notNull(),
  },
  (table) => [
    index('request_logs_time_idx').on(table.time.desc()),
    index('request_logs_org_time_idx').on(table.orgId, table.time.desc()),
    index('request_logs_key_time_idx').on(table.keyId, table.time.desc()),
    index('request_logs_service_time_idx').on(table.serviceId, table.time.desc()),
  ],
);

export const orgWebhooks = pgTable(
  'org_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastAlertedThreshold: integer('last_alerted_threshold'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('org_webhooks_org_idx').on(table.orgId)],
);

/**
 * Durable outbox for quota webhook deliveries.
 *
 * Delivery used to happen inline inside the telemetry flush: `await
 * dispatchWebhook(...)` with a 5s timeout, per webhook, per touched org. One
 * endpoint that accepted the connection and never answered therefore stalled
 * the single-flighted ingest loop for everyone, and a failure was lost with no
 * record. Rows here are written cheaply and drained by a background worker with
 * backoff, so the request path never waits on a third party and a failed alert
 * is still visible.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => orgWebhooks.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'), // pending | delivered | failed
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => [
    index('webhook_deliveries_pending_idx').on(table.status, table.nextAttemptAt),
    index('webhook_deliveries_webhook_idx').on(table.webhookId, table.createdAt),
    index('webhook_deliveries_org_idx').on(table.orgId, table.createdAt),
  ],
);

export const chaosRules = pgTable(
  'chaos_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').references(() => mockServices.id, { onDelete: 'cascade' }),
    keyId: uuid('key_id').references(() => apiKeys.id, { onDelete: 'cascade' }),
    isEnabled: boolean('is_enabled').notNull().default(false),
    latency: jsonb('latency').notNull().default({
      enabled: false,
      distribution: 'normal',
      meanMs: 200,
      stddevMs: 50,
      minMs: 0,
      maxMs: 30000,
    }),
    errors: jsonb('errors')
      .notNull()
      .default({
        enabled: false,
        rate5xx: 0.0,
        rate429: 0.0,
        statusCodes: [500, 502, 503, 504],
      }),
    partition: jsonb('partition').notNull().default({
      enabled: false,
      dropRate: 0.0,
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('chaos_rules_org_idx').on(table.orgId),
    uniqueIndex('chaos_rules_scope_idx').on(table.orgId, table.serviceId, table.keyId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  memberships: many(orgMembers),
}));

export const orgsRelations = relations(orgs, ({ one, many }) => ({
  owner: one(users, { fields: [orgs.ownerId], references: [users.id] }),
  members: many(orgMembers),
}));

export const orgMembersRelations = relations(orgMembers, ({ one }) => ({
  org: one(orgs, { fields: [orgMembers.orgId], references: [orgs.id] }),
  user: one(users, { fields: [orgMembers.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const apiKeyFamiliesRelations = relations(apiKeyFamilies, ({ one, many }) => ({
  org: one(orgs, { fields: [apiKeyFamilies.orgId], references: [orgs.id] }),
  keys: many(apiKeys),
}));

export const apiKeysRelations = relations(apiKeys, ({ one, many }) => ({
  org: one(orgs, { fields: [apiKeys.orgId], references: [orgs.id] }),
  family: one(apiKeyFamilies, { fields: [apiKeys.familyId], references: [apiKeyFamilies.id] }),
  createdByUser: one(users, { fields: [apiKeys.createdBy], references: [users.id] }),
  events: many(apiKeyEvents),
}));

export const apiKeyEventsRelations = relations(apiKeyEvents, ({ one }) => ({
  key: one(apiKeys, { fields: [apiKeyEvents.keyId], references: [apiKeys.id] }),
}));

export const mockServicesRelations = relations(mockServices, ({ one, many }) => ({
  org: one(orgs, { fields: [mockServices.orgId], references: [orgs.id] }),
  routes: many(mockRoutes),
}));

export const mockRoutesRelations = relations(mockRoutes, ({ one }) => ({
  service: one(mockServices, { fields: [mockRoutes.serviceId], references: [mockServices.id] }),
}));

export const requestLogsRelations = relations(requestLogs, ({ one }) => ({
  org: one(orgs, { fields: [requestLogs.orgId], references: [orgs.id] }),
  key: one(apiKeys, { fields: [requestLogs.keyId], references: [apiKeys.id] }),
  service: one(mockServices, { fields: [requestLogs.serviceId], references: [mockServices.id] }),
}));

export const orgWebhooksRelations = relations(orgWebhooks, ({ one }) => ({
  org: one(orgs, { fields: [orgWebhooks.orgId], references: [orgs.id] }),
}));

export const chaosRulesRelations = relations(chaosRules, ({ one }) => ({
  org: one(orgs, { fields: [chaosRules.orgId], references: [orgs.id] }),
  service: one(mockServices, { fields: [chaosRules.serviceId], references: [mockServices.id] }),
  key: one(apiKeys, { fields: [chaosRules.keyId], references: [apiKeys.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type ApiKeyFamily = typeof apiKeyFamilies.$inferSelect;
export type MockService = typeof mockServices.$inferSelect;
export type NewMockService = typeof mockServices.$inferInsert;
export type MockRoute = typeof mockRoutes.$inferSelect;
export type NewMockRoute = typeof mockRoutes.$inferInsert;
export type PlanRow = typeof plans.$inferSelect;
export type NewPlanRow = typeof plans.$inferInsert;

export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type OrgWebhook = typeof orgWebhooks.$inferSelect;
export type NewOrgWebhook = typeof orgWebhooks.$inferInsert;
export type ChaosRule = typeof chaosRules.$inferSelect;
export type NewChaosRule = typeof chaosRules.$inferInsert;

// ---------------------------------------------------------------------------
// Time-Travel Playground (Phase 7)
// ---------------------------------------------------------------------------

export const playgroundKindEnum = pgEnum('playground_kind', PLAYGROUND_REQUEST_KINDS);
export const playgroundOutcomeEnum = pgEnum('playground_outcome', PLAYGROUND_OUTCOMES);

export const playgroundSessions = pgTable(
  'playground_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull().default('Untitled session'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('playground_sessions_org_idx').on(table.orgId, table.createdAt.desc())],
);

export const playgroundRequests = pgTable(
  'playground_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => playgroundSessions.id, { onDelete: 'cascade' }),
    /** Denormalised so every query can be scoped by tenant without a join. */
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    keyId: uuid('key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => playgroundRequests.id, {
      onDelete: 'set null',
    }),
    kind: playgroundKindEnum('kind').notNull().default('send'),

    method: httpMethodEnum('method').notNull(),
    serviceSlug: text('service_slug').notNull(),
    path: text('path').notNull(),
    query: jsonb('query')
      .notNull()
      .default(sql`'{}'::jsonb`),
    headers: jsonb('headers')
      .notNull()
      .default(sql`'{}'::jsonb`),
    body: text('body'),

    outcome: playgroundOutcomeEnum('outcome').notNull().default('ok'),
    responseStatus: integer('response_status'),
    responseHeaders: jsonb('response_headers')
      .notNull()
      .default(sql`'{}'::jsonb`),
    responseBody: text('response_body').notNull().default(''),
    responseTruncated: boolean('response_truncated').notNull().default(false),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('playground_requests_session_idx').on(table.sessionId, table.createdAt.desc()),
    index('playground_requests_org_idx').on(table.orgId),
    index('playground_requests_created_idx').on(table.createdAt),
  ],
);

export const playgroundSessionsRelations = relations(playgroundSessions, ({ one, many }) => ({
  org: one(orgs, { fields: [playgroundSessions.orgId], references: [orgs.id] }),
  requests: many(playgroundRequests),
}));

export const playgroundRequestsRelations = relations(playgroundRequests, ({ one }) => ({
  session: one(playgroundSessions, {
    fields: [playgroundRequests.sessionId],
    references: [playgroundSessions.id],
  }),
  key: one(apiKeys, { fields: [playgroundRequests.keyId], references: [apiKeys.id] }),
}));

export type PlaygroundSessionRow = typeof playgroundSessions.$inferSelect;
export type PlaygroundRequestRow = typeof playgroundRequests.$inferSelect;
export type NewPlaygroundRequestRow = typeof playgroundRequests.$inferInsert;
