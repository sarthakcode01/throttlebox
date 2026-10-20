import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { KEY_ENVS, KEY_STATUSES, PLANS, ROLES } from '@throttlebox/shared';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ROLES);
export const planEnum = pgEnum('plan', PLANS);
export const keyEnvEnum = pgEnum('key_env', KEY_ENVS);
export const keyStatusEnum = pgEnum('key_status', KEY_STATUSES);

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
// Relations
// ---------------------------------------------------------------------------

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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type ApiKeyFamily = typeof apiKeyFamilies.$inferSelect;
