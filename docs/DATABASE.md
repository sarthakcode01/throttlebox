# Database

PostgreSQL 16 with the TimescaleDB extension (`timescale/timescaledb:latest-pg16`). Schema is defined in `apps/server/src/db/schema.ts` (Drizzle) and migrated via `apps/server/drizzle/`.

## Enums

`role` (owner, admin, dev, viewer), `plan` (free, pro), `key_env` (test, live), `key_status` (active, revoked), `http_method` (GET, POST, PUT, PATCH, DELETE).

## Tables

| Table              | Purpose / notable columns                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plans`            | Plan catalogue (limits are also defined in `@throttlebox/shared` `PLAN_CONFIGS`, which is what the limiter actually reads)                                                                                                     |
| `users`            | email, password hash (Argon2id), name                                                                                                                                                                                          |
| `sessions`         | SHA-256 hash of session token, user, expiry — durable copy; Redis is the hot cache                                                                                                                                             |
| `orgs`             | name, `plan`                                                                                                                                                                                                                   |
| `org_members`      | (user, org, role) membership                                                                                                                                                                                                   |
| `api_key_families` | Groups a rotation chain; revoking a family kills every key                                                                                                                                                                     |
| `api_keys`         | `public_id` (indexed lookup), HMAC hash, prefix, last4, env, scopes, status, family, `last_used_at`, grace expiry                                                                                                              |
| `api_key_events`   | Audit trail (created / rotated / revoked / used…) incl. client IP                                                                                                                                                              |
| `mock_services`    | org-scoped, slug, name, active flag                                                                                                                                                                                            |
| `mock_routes`      | service, `method`, `path` (e.g. `/products/:id`), `status_code`, `response_template` (jsonb), `response_headers` (jsonb), `latency_ms`, `weighted_responses` (reserved), `is_active`, ordering; unique per service+method+path |
| `request_logs`     | **Hypertable** on `time`: key_id, org_id, service_id, method, path, status_code, latency_ms, rate_limited, trace_id. Indexes on time, (org,time), (key,time), (service,time)                                                   |
| `org_webhooks`     | url, HMAC `secret`, `is_active`, `last_alerted_threshold` (80/100)                                                                                                                                                             |
| `chaos_rules`      | org, optional service, optional key, `is_enabled`, jsonb `latency` / `errors` / `partition`; unique on (org, service, key)                                                                                                     |

FKs on `request_logs`: key and service `ON DELETE SET NULL`, org `ON DELETE CASCADE`.

## Migrations

| #         | Content                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0000–0003 | Core schema: users/sessions/orgs/members, keys/families/events, mock services/routes, plans                                                                |
| 0004      | `org_webhooks`, `request_logs`, indexes; `create_hypertable('request_logs','time')`; continuous aggregate `usage_hourly`                                   |
| 0005      | TimescaleDB policies (guarded by `pg_extension` check): aggregate refresh every hour (start −1 month, end −1 hour), **30-day retention** on `request_logs` |
| 0006      | `chaos_rules`                                                                                                                                              |
| 0007      | `playground_sessions`, `playground_requests`, enums `playground_kind` (send/replay/fork) and `playground_outcome` (ok/dropped/error)                       |

`playground_requests` stores the full request and response (headers and bodies as captured, credentials stripped, bodies capped at 64 KB with `response_truncated`), a self-referencing `parent_id` for replay/fork lineage, and a denormalised `org_id` so every query is tenant-scoped without a join. History older than 30 days is purged by a background janitor.

**Journal rule:** every `.sql` file must be listed in `drizzle/meta/_journal.json`, or `pnpm db:migrate` silently skips it. 0005 and 0006 were missing from the journal until Phase 7 testing caught it; `tests/config/migrations.test.ts` now enforces it.

Snapshots exist for 0000–0004 and 0007. 0005 (hand-written Timescale policies) and 0006 have none, so `drizzle-kit generate` re-emits `chaos_rules`; the 0007 SQL had those statements removed by hand. Expect to do the same for the next generated migration until a snapshot for 0006 is added.

## `usage_hourly` continuous aggregate

Per `bucket (1h), org_id, key_id, service_id`: `requests`, `errors` (status ≥ 400), `throttled`, `p50/p95/p99` (`percentile_cont` over latency). `getUsageSeries` reads it for ranges ≥ 24h; latency/error/overview queries still scan raw `request_logs` (audit item H6).

## Redis keyspace

| Key / channel                                          | Use                                               |
| ------------------------------------------------------ | ------------------------------------------------- |
| `rate:org:<orgId>`                                     | Sorted set, score = ms timestamp — sliding window |
| `tier:org:<orgId>`                                     | Cached plan name (60 s)                           |
| `chaos:rule:<org>:<service                             | _>:<key                                           | _>` | Cached chaos rule (60 s) |
| session keys                                           | Session cache (see `auth/session.ts`)             |
| key verification cache                                 | See `keys/cache.ts`                               |
| `plan:changed`, `chaos:invalidated` (+ router channel) | Pub/sub invalidation                              |
