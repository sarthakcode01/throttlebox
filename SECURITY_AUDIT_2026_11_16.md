# Throttlebox — Full Security Audit (Phases 0–6)

**Audit date:** 2026-11-16
**Scope:** `apps/server/src/**`, `packages/shared/src/index.ts`, `apps/web/src/**` (auth/session surface), `docker-compose.yml`, `apps/server/drizzle/**`
**Method:** Manual phase-by-phase review of every source file, tracing each request path from the Fastify entry point through auth, key verification, rate limiting, mock rendering, telemetry, and chaos injection.

This is a **security** audit, distinct from `PROJECT_MISTAKES_AND_TECHNICAL_DEBT_AUDIT.md` (2026-11-07), which covered defects and architectural mismatches. Where an issue from that document has since been fixed, it is marked **[FIXED]**. Where it is still open, it is marked **[OPEN]**.

---

## Severity summary

| ID | Severity | Issue | Status |
| :-- | :------: | :---- | :----: |
| C1 | 🔴 Critical | SSRF via DNS rebinding, redirects, IPv6/numeric-IP bypass | OPEN |
| C2 | 🔴 Critical | Webhook HMAC secret returned in API responses | OPEN |
| C3 | 🔴 Critical | SSRF guard is TOCTOU; no egress filtering | OPEN |
| H1 | 🟠 High | `X-Forwarded-For` trust model is fragile | OPEN |
| H2 | 🟠 High | Auth rate limiter is per-process, in-memory | OPEN |
| H3 | 🟠 High | Session role/orgId cached up to 7 days; no revalidation | OPEN |
| H4 | 🟠 High | No session binding to client (UA/IP) | OPEN |
| H5 | 🟠 High | FK `ON DELETE CASCADE` on TimescaleDB hypertable | OPEN |
| H6 | 🟠 High | Latency/error queries bypass `usage_hourly` CAGG | OPEN |
| H7 | 🟠 High | Webhook dispatch has no durable queue / DLQ | OPEN |
| H8 | 🟠 High | No rate limit on `/api/*`; chaos benchmark is a compute amplifier | OPEN |
| M1 | 🟡 Medium | No rate limiting on the dashboard API | OPEN |
| M2 | 🟡 Medium | `count(*)` full scan on every `/api/analytics/logs` call | OPEN |
| M3 | 🟡 Medium | Analytics `keyId`/`serviceId` filters not ownership-checked | OPEN |
| M4 | 🟡 Medium | Chart time-buckets not zero-filled | OPEN |
| M5 | 🟡 Medium | Chaos cache invalidation uses blocking `KEYS` | OPEN |
| M6 | 🟡 Medium | Key cache stores `secretHash` in Redis | OPEN |
| M7 | 🟡 Medium | **Key cache has no pub/sub → revoked key live up to 60s on other instances** | OPEN |
| M8 | 🟡 Medium | `touch()` write-behind buffer is per-process and lossy | OPEN |
| M9 | 🟡 Medium | Open registration, no CAPTCHA / email verification | OPEN |
| M10 | 🟡 Medium | Weak password policy (min 10, no breach check) | OPEN |
| M11 | 🟡 Medium | `safeEqualString` length check leaks token length | OPEN |
| M12 | 🟡 Medium | Error handler leaks messages outside production | OPEN |
| M13 | 🟡 Medium | CORS origin list unvalidated | OPEN |
| M14 | 🟡 Medium | No HSTS header | OPEN |
| M15 | 🟡 Medium | No CSP on API or web app | OPEN |
| L1–L15 | 🟢 Low | Hardening notes and verified-good patterns | — |

---

## 🔴 Critical

### C1 — SSRF in webhooks: DNS rebinding, redirects, and address-encoding bypass

**Location:** `apps/server/src/analytics/webhooks.ts` → `isValidWebhookUrl()`

The validator inspects the **hostname string** only. It never resolves the name to an address, and it never constrains what `fetch()` may connect to. Four independent bypasses exist:

1. **DNS rebinding.** `https://attacker.example` resolves to a public IP when `isValidWebhookUrl` runs, then to `169.254.169.254` or `127.0.0.1` when `fetch()` runs. The lexical checks see a clean hostname both times.
2. **HTTP redirects.** `fetch()` follows redirects by default. A permitted public URL can `302` to `http://169.254.169.254/latest/meta-data/` and the guard never re-runs.
3. **IPv4-mapped and translated IPv6.** Only `::1`, `fe80:`, `fc00:`, `fd00:` are rejected. `::ffff:127.0.0.1`, `::ffff:169.254.169.254`, and NAT64 `64:ff9b::` forms pass through.
4. **Alternate IPv4 encodings.** `http://2130706433/` (decimal for 127.0.0.1), `http://0177.0.0.1/`, `http://0x7f000001/`, and `http://127.1/` all fail the dotted-quad regex and are treated as ordinary hostnames.

**Impact:** an authenticated user with `analytics:write` can turn Throttlebox into an SSRF proxy against cloud metadata, PostgreSQL, Redis, or any internal VPC service. `POST /api/analytics/webhooks/:id/test` triggers the request on demand.

**Fix:**
- Resolve the hostname with `dns.lookup(host, { all: true })` and reject if **any** resolved address is loopback, RFC 1918, link-local, CGNAT, or IPv4-mapped.
- Use `redirect: 'manual'` and re-run the full validation on every hop (bounded hop count).
- Canonicalize numeric hosts (`inet_pton`-equivalent) before the lexical checks.
- Block `::ffff:0:0/96` and `64:ff9b::/96` explicitly.

---

### C2 — Webhook HMAC secret disclosed in API responses

**Location:** `apps/server/src/analytics/webhooks.ts` → `toWebhookConfig()`; exposed by `GET /api/analytics/webhooks` in `apps/server/src/routes/analytics.ts`

```ts
export function toWebhookConfig(row: OrgWebhook): WebhookConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    url: row.url,
    secret: row.secret,   // ← returned verbatim to the client
    ...
  };
}
```

The HMAC signing secret is a credential. It is generated server-side (`whsec_…`) or supplied by the user, and it is the only thing that lets a receiver verify a payload genuinely came from Throttlebox. Returning it on every list call means:

- Any XSS, browser extension, or shoulder-surf on the dashboard leaks it.
- It lands in browser memory, React Query caches, and any client-side logging.
- Combined with C1, an attacker who reads the secret can forge correctly-signed quota events to arbitrary destinations.

This is inconsistent with the project's own API-key design, where the raw key is shown exactly once and is unrecoverable.

**Fix:** treat the secret as write-only. Return `secret: null` plus `hasSecret: boolean` (or a masked `whsec_…abcd`) in list/get responses. Accept a new secret only on create and on an explicit rotate operation.

---

### C3 — SSRF guard is TOCTOU and there is no egress filtering

**Location:** `apps/server/src/analytics/webhooks.ts` → `dispatchWebhook()`

`isValidWebhookUrl(webhook.url)` and `fetch(webhook.url, …)` are separate operations. Even after C1 is fixed, the check-then-use gap remains, and there is no network-level backstop (no egress allowlist, no firewall rule, no IMDSv2 requirement).

**Fix:** treat the application guard as one layer, not the only layer. Document and enforce an egress policy; where the deployment allows it, require IMDSv2 and block the metadata endpoint at the network layer.

---

## 🟠 High

### H1 — `X-Forwarded-For` trust model is fragile

**Location:** `apps/server/src/index.ts`

```ts
const trustProxy = (address: string, hop: number): boolean => hop < config.TRUST_PROXY_HOPS;
```

This is correct **only** when exactly `TRUST_PROXY_HOPS` trusted proxies sit in front and each one *appends* to the header. Failure modes:

- Set to `1` while the app is directly reachable → any client can spoof `request.ip`.
- A proxy that *replaces* rather than appends → the count is wrong.
- Default is `0`, which is safe, but a single misconfiguration silently disables the control.

`request.ip` is what the **API key audit trail** (`api_key_events.ip`) and the **auth rate limiter** (`auth:${request.ip}`) key on. Spoofing it writes false evidence into the audit trail and lets an attacker shard credential-stuffing attempts across unlimited apparent IPs.

**Fix:** verify the immediate socket peer against a configured proxy CIDR allowlist rather than counting hops; refuse to start if `TRUST_PROXY_HOPS > 0` but no trusted-proxy range is configured.

---

### H2 — Auth rate limiter is per-process and in-memory

**Location:** `apps/server/src/http/rateLimit.ts`, used by `apps/server/src/routes/auth.ts`

`createRateLimit` keeps buckets in a `Map` inside the Node process. The file's own comment acknowledges the consequence: *"this limiter is per-process, so a multi-instance deployment gets N times the limit."*

Phase 9 targets Fly.io/Railway with multiple instances. At N replicas the effective ceiling on `/api/auth/login` becomes `N × AUTH_RATE_LIMIT_MAX` (default `N × 20` per 15 minutes), which materially weakens the credential-stuffing defence that is the limiter's entire purpose. Argon2id verification is the expensive operation being protected.

**Fix:** back this limiter with Redis, reusing the atomic Lua sliding-window primitive already implemented in `apps/server/src/ratelimit/lua.ts`. Keep the in-memory limiter only as a local first-line cache in front of it.

---

### H3 — Session role and orgId are cached for up to 7 days with no revalidation

**Location:** `apps/server/src/auth/middleware.ts`, `apps/server/src/auth/session.ts`

`resolveSession()` returns a cached `SessionRecord` containing `orgId` and `role`. The middleware only queries `org_members` when those fields are **missing**:

```ts
if (!orgId || !role) {
  const [membership] = await db.select({...}).from(orgMembers)...
}
```

Once warmed, they are never re-checked. `redis.expire(...)` slides the TTL forward on every request, so an active session can carry its original `role` indefinitely — up to the 7-day `SESSION_TTL_SECONDS` ceiling, and longer in practice because each request refreshes it.

**Impact:** `requirePermission()` authorizes against a stale role. If a user is demoted from `admin` to `viewer`, or removed from an org entirely, they retain the old privileges for as long as they keep using the session. There is no membership-version check and no revocation hook.

**Fix:** store a `membershipVersion` (or `roleUpdatedAt`) in the session record and re-validate against `org_members` when it is older than a short interval (e.g. 60s), or bump the version on any role/org change and treat a mismatch as a cache miss.

---

### H4 — No session binding to client

**Location:** `apps/server/src/auth/session.ts`

Sessions are bearer tokens in a cookie with no binding to the client. A stolen token is usable from any host until it expires (7 days, sliding). There is no `userAgent`/IP fingerprint check at resolve time, even though both are captured at creation and stored in the `sessions` table for audit.

**Fix:** bind the session to a hash of `user-agent` (+ optionally the network prefix) and reject or re-prompt on mismatch. At minimum, emit a structured warning when the presenting client differs from the one recorded at creation.

---

### H5 — Foreign keys with `ON DELETE CASCADE` on a TimescaleDB hypertable

**Location:** `apps/server/src/db/schema.ts` (`requestLogs`), `apps/server/drizzle/0004_hesitant_mongoose.sql`

```ts
orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
keyId: uuid('key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
serviceId: uuid('service_id').references(() => mockServices.id, { onDelete: 'set null' }),
```

`request_logs` is converted to a hypertable by the same migration. Foreign keys on hypertables force PostgreSQL to lock and scan every chunk on delete. Deleting one org, key, or service can therefore lock the hypertable and stall active inserts. This is Issue 11 from the November audit and is **[OPEN]**.

Note the inconsistency: `api_key_events.org_id` deliberately has **no** FK, with a comment explaining that the audit trail should outlive the objects it describes. `request_logs` was not given the same treatment.

**Fix:** drop the FK constraints on `request_logs` and rely on the retention policy (`0005_timescale_policies.sql` already drops after 30 days) plus a background sweep for orphaned `key_id`/`service_id`.

---

### H6 — Latency and error analytics bypass the continuous aggregate

**Location:** `apps/server/src/analytics/service.ts`

`getUsageSeries()` was updated to read `usage_hourly` for ranges ≥ 24h — **[FIXED]**, and it correctly falls back to raw logs on error. But three queries still scan the raw hypertable across the whole range:

- `getOverview()` — `percentile_cont(0.95)` over `request_logs`
- `getLatencySeries()` — `percentile_cont(0.50/0.95/0.99)` over `request_logs`
- `getErrorsBreakdown()` — filtered counts plus a `GROUP BY path, status_code` over `request_logs`

`usage_hourly` already stores `p50`, `p95`, `p99`, `requests`, `errors`, and `throttled` per hour. The latency and error queries should read from it for 24h/7d/30d, reserving raw-log scans for the 1h real-time window. This is Issue 2 from the November audit, **[OPEN]** for these three queries.

---

### H7 — Webhook dispatch has no durable queue or dead-letter path

**Location:** `apps/server/src/analytics/webhooks.ts`, `apps/server/src/analytics/quotaMonitor.ts`

Dispatch is a bare `fetch()` with `AbortSignal.timeout(5000)`. There is no retry, no backoff, no persistence, and no DLQ. A quota alert that hits a transient 503 or a network blip is lost permanently, and `lastAlertedThreshold` is still advanced, so it is never retried.

`Promise.allSettled` in `checkSingleOrgQuota` fixed the sequential-blocking problem from the November audit — **[FIXED]**. The durability half is **[OPEN]**. `PHASES.md` and `API_DEVELOPER_PORTAL_PLAN.md` both specified BullMQ with exponential backoff and a DLQ.

**Fix:** move dispatch onto a Redis-backed queue (BullMQ) with exponential backoff, a bounded attempt count, and a dead-letter list. Advance `lastAlertedThreshold` only after a successful delivery.

---

### H8 — No rate limit on `/api/*`; chaos benchmark is a compute amplifier

**Location:** all `apps/server/src/routes/*.ts`; specifically `routes/chaos.ts` → `POST /api/chaos/benchmark`

Only `/mock/*` (via `rateLimitMock`) and the two credential endpoints (via `authRateLimiter`) are rate limited. Every `/api/*` route — keys, services, analytics, chaos, org — is unthrottled for an authenticated caller.

The sharpest edge is `POST /api/chaos/benchmark`, which runs up to 200 iterations of sampling synchronously inside the request handler and returns percentiles. It is cheap per call but unbounded in call frequency, and it is pure server-side compute with no I/O to absorb it. The analytics endpoints are the other hot spot (see M2).

**Fix:** add a per-user dashboard limiter (Phase 9 deliverable) keyed on `auth.userId`, applied as a `preHandler` across `/api/*`, with a lower ceiling on `/api/chaos/benchmark` and `/api/analytics/*`.

---

## 🟡 Medium

### M1 — No rate limiting on the dashboard API
As described in H8. Tracked separately because it is the Phase 9 hardening item in its own right: a dedicated per-user limiter, distinct from the per-key mock limiter.

### M2 — `count(*)` full scan on every logs request
**Location:** `apps/server/src/analytics/service.ts` → `getRecentLogs()`

```sql
SELECT count(*)::int AS count FROM request_logs WHERE org_id = ${orgId};
```

Runs on every `GET /api/analytics/logs` call. `limit`/`offset` are clamped (`Math.min(Math.max(limit,1),100)`), which is good, but the total is an exact count over a hypertable. This degrades as the table grows and is polled every 5s by the dashboard.

**Fix:** source the total from `usage_hourly`, or return an approximate count, or drop the total and paginate with a cursor.

### M3 — Analytics `keyId`/`serviceId` filters not ownership-checked
**Location:** `apps/server/src/routes/analytics.ts` → `GET /api/analytics/usage`

`query.keyId` and `query.serviceId` are passed through to `getUsageSeries` and interpolated into SQL. They are properly parameterized by `postgres` (no injection), and the `org_id` predicate still scopes results to the caller's org, so cross-tenant data leakage is limited. But there is no validation that the supplied IDs belong to the caller, so a user can query for a foreign `keyId` and receive an empty series — an oracle for ID existence, and a source of confusing UI states.

**Fix:** validate `keyId`/`serviceId` against `api_keys.org_id` / `mock_services.org_id` before querying, returning 404 on mismatch.

### M4 — Chart time-buckets are not zero-filled
**Location:** `apps/server/src/analytics/service.ts`, `apps/web/src/app/dashboard/analytics/page.tsx`

`time_bucket()` only returns buckets containing rows. The SVG charts compute X coordinates from the array index, so a four-hour gap renders as a smooth slope rather than a drop to zero. Issue 13 from the November audit, **[OPEN]**.

**Fix:** zero-fill missing buckets server-side, or compute X from `(timestamp - min) / (max - min)`.

### M5 — Chaos cache invalidation uses blocking `KEYS`
**Location:** `apps/server/src/chaos/cache.ts` → `invalidateChaosRule()`

```ts
const keys = await redis.keys(`chaos:rule:${orgId}:*`);
```

`KEYS` is O(keyspace) and blocks the Redis event loop. It runs on every org-default chaos update and reset. Should be `SCAN` with a cursor, or an index set per org.

### M6 — Key cache stores `secretHash` in Redis
**Location:** `apps/server/src/keys/cache.ts`, `apps/server/src/keys/verify.ts`

`CachedKeyRow` includes `secretHash`, so a Redis compromise yields offline-verifiable material. It is still pepper-protected (the attacker needs `KEY_PEPPER` from the environment), so this is not a direct break — but it widens the blast radius of a cache leak and is worth an explicit note in the ADR.

**Fix:** document the trade-off, or store a Redis-only fast-path verifier and re-read the hash from Postgres on cache miss.

### M7 — Key cache has no pub/sub invalidation: revoked keys stay live up to 60s on other instances

**Location:** `apps/server/src/keys/cache.ts`

Tier changes, router changes, and chaos rules all broadcast invalidation over Redis pub/sub (`plan:changed`, `router:invalidated`, `chaos:invalidated`). The **key** cache does not. `invalidateCachedKey()` / `invalidateCachedKeyById()` / `invalidateFamilyKeyCache()` only issue `DEL` against the shared Redis — which does clear the shared copy, but any instance that already holds a local copy is unaffected, and more importantly there is no `KEY_CACHE` invalidation channel for a future in-process cache layer.

The concrete risk today: `KEY_CACHE_TTL_SECONDS = 60`. A key revoked on instance A is purged from Redis, but any instance that read the row into a local structure, or any race between `DEL` and an in-flight `GET`, can serve the revoked key for up to the TTL. For a **revocation** path — the security-critical one — a 60-second window is a long time, and it is exactly the "correctness trap" the Phase 2 plan warned about.

Note the November audit's Issue 10 covered the *router* cache lacking pub/sub; that one is **[FIXED]** (`startRouterPubSub` exists). The *key* cache has the same shape of problem and was not fixed.

**Fix:** add a `key:invalidated` channel and broadcast on every revoke/rotate/family-revoke, mirroring `invalidateRouterCache`. Additionally, treat revocation as needing a hard guarantee: either drop the TTL to a few seconds or maintain a short-lived revocation set that is checked before the cache.

### M8 — `touch()` write-behind buffer is per-process and lossy
**Location:** `apps/server/src/keys/touch.ts`

Acknowledged in the source. Buffered `last_used_at` writes are lost on crash and are not shared across instances. Acceptable for a display field; documented here for completeness.

### M9 — Open registration with no CAPTCHA or email verification
**Location:** `apps/server/src/routes/auth.ts` → `POST /api/auth/register`

The only brake is the per-IP limiter, which is per-process (H2). Each registration creates a user, an org, and a seeded flagship service. Mass registration is therefore a database-growth and CPU-burn vector (Argon2id hashing on every attempt). Email verification is explicitly out of scope per `API_DEVELOPER_PORTAL_PLAN.md`, but the abuse case should be recorded.

### M10 — Weak password policy
**Location:** `apps/server/src/routes/auth.ts`

`password: z.string().min(10).max(200)`. No composition requirement, no breached-password check, no strength estimator. Ten characters is the floor. Argon2id parameters (19 MiB, t=2, p=1) are reasonable for interactive login.

**Fix:** add a breached-password check (HIBP k-anonymity API) or an estimator, and raise the floor to 12.

### M11 — `safeEqualString` length check leaks token length
**Location:** `apps/server/src/util/crypto.ts`

```ts
if (expected.length !== actual.length) return false;
```

The early return short-circuits before `timingSafeEqual`, so comparison time reveals whether the lengths match. For the CSRF double-submit check both values are fixed 64-char hex tokens, so the practical risk is low — but this helper is presented as a general constant-time primitive, and the length *is* secret in other potential uses.

**Fix:** document that length is not treated as secret, or hash both sides to a fixed width before comparing.

### M12 — Error handler leaks messages outside production
**Location:** `apps/server/src/http/errorHandler.ts`

`message: isProduction ? 'Something went wrong' : error.message`. Correct for local development, but it means any environment where `NODE_ENV` is not exactly `production` will return raw database errors and constraint names to clients. `config.ts` validates `NODE_ENV` as `development | test | production`, so a staging deployment left at `development` leaks freely.

**Fix:** gate on an explicit `EXPOSE_ERROR_DETAILS` flag rather than inferring from `NODE_ENV`.

### M13 — CORS origin list is unvalidated
**Location:** `apps/server/src/index.ts`

```ts
origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','),
credentials: true,
```

A comma-split with no validation. A misconfigured `WEB_ORIGIN` of `*`, or one containing an untrusted origin, combined with `credentials: true`, permits credentialed cross-origin reads of the dashboard API. No check that origins are HTTPS in production.

**Fix:** validate each origin parses as a URL with an expected protocol, reject `*` when credentials are enabled, and require HTTPS when `NODE_ENV === 'production'`.

### M14 — No HSTS header
**Location:** `apps/server/src/http/securityHeaders.ts`

Sets `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `X-DNS-Prefetch-Control`, `Cross-Origin-Opener-Policy`, and strips `X-Powered-By` — but not `Strict-Transport-Security`.

**Fix:** add `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production.

### M15 — No Content-Security-Policy
**Location:** `apps/server/src/http/securityHeaders.ts`, `apps/web/next.config.ts`

The API's own comment says the strictest CSP "is set by the web app itself," but `next.config.ts` contains no header configuration. The dashboard is a client-rendered React app that renders user-controlled content (mock service names, route paths, webhook URLs, chaos custom messages), so a CSP is a meaningful second line of defence against an injection that reaches the DOM.

**Fix:** add a CSP via `next.config.ts` `headers()` (or middleware), starting report-only.

---

## 🟢 Low and verified-good

| ID | Note |
| :-- | :---- |
| L1 | `docker-compose.yml` ships default `postgres`/`postgres` credentials and publishes 5432/6379 on all interfaces. Acceptable for local dev only; must never be deployed. |
| L2 | Redis has no `requirepass`. Same constraint as L1. |
| L3 | `parseKey()` splits on `_` with fixed arity 4. Correct — base62 segments cannot contain `_`, so arity is stable. |
| L4 | `randomBase62()` uses rejection sampling with `MAX_UNBIASED_BYTE = 248`. Correct; `Math.random()` is never used for key material. |
| L5 | `DUMMY_HASH` in `routes/auth.ts` is a fixed Argon2id digest of a random value, verified on the no-user path to flatten login timing. Correct. |
| L6 | **Template sandbox is solid.** `mock/template.ts` has no `eval`; expressions are dotted paths resolved by walking an object graph; faker namespaces are a closed allowlist with `helpers` deliberately excluded (it would allow `faker.helpers.fake` to evaluate another template); `__proto__`/`constructor`/`prototype` are refused at every step; only own properties are read; depth is capped at 6; each request gets a fresh `Faker` instance; failures resolve to `undefined` and the response still renders. No injection path found. |
| L7 | `mockParams()` in `routes/mock.ts` deliberately parses `request.raw.url` instead of using the wildcard param, because Fastify decodes route params and `find-my-way` decodes again. This is the correct fix for the double-decode bug and keeps an encoded `%2F` inside its parameter. |
| L8 | `seedFrom(orgId, serviceSlug, method, path)` — the seed is scoped to the organization, not the credential, so two keys in one org see identical data and the dashboard preview matches a real response. Correct. |
| L9 | `recordEventSafe()` swallows failures by design. The documented write-amplification vector remains: a caller who knows a valid `publicId` can force one `api_key_events` INSERT per request by sending a wrong secret, and the Phase 4 limiter runs *after* verification so it does not cover this path. Needs a retention policy plus sampling or de-duplication. |
| L10 | `chaos/middleware.ts` calls `reply.hijack()` before `request.raw.destroy()` on a partition drop. Correct — it prevents downstream handlers running and avoids write-after-destroy. |
| L11 | `DELETE /api/analytics/webhooks/:id` does not validate that `id` is a UUID. The value is parameterized, so there is no injection; a malformed id simply deletes nothing. Cosmetic. |
| L12 | `routes/chaos.ts` benchmark uses `Math.random()` for synthetic base latency. Not security-relevant. |
| L13 | `X-Frame-Options: DENY` is set on API responses, which is useful for clickjacking defence on any HTML the API ever serves. |
| L14 | Session cookie is `httpOnly`, `Secure` in production, `SameSite=Lax`; CSRF cookie is deliberately readable and carries the double-submit token; the CSRF hook exempts requests carrying an `Authorization` header, which is correct because a browser never attaches one on its own. This design is sound. |
| L15 | `destroyAllSessionsForUser()` exists in `auth/session.ts` but is **never called**. There is no "sign out everywhere" feature and no session revocation on credential change (no change-password feature exists). Dead code that signals a missing capability. |

---

## Prioritized remediation

### P0 — exploitable now

| ID | Action |
| :-- | :---- |
| **C1** | Resolve hostnames and validate every resolved IP; `redirect: 'manual'` with per-hop revalidation; block `::ffff:0:0/96` and `64:ff9b::/96`; canonicalize numeric hosts. |
| **C2** | Make the webhook secret write-only; return `hasSecret` or a masked value. |
| **M7** | Add a `key:invalidated` pub/sub channel and broadcast on revoke / rotate / family-revoke. Treat revocation as requiring a hard guarantee, not a 60s TTL. |

### P1 — hardening before any multi-instance or public deployment

| ID | Action |
| :-- | :---- |
| **H3** | Add membership versioning; revalidate role/orgId on a short interval. |
| **H2** | Move the credential limiter to the Redis Lua sliding window. |
| **H5** | Drop FKs on `request_logs`; rely on retention plus a background sweep. |
| **H6** | Route latency and error queries through `usage_hourly`. |
| **H7** | Move webhook dispatch to BullMQ with backoff and a DLQ; advance `lastAlertedThreshold` only on success. |
| **H1** | Verify the socket peer against a trusted-proxy CIDR instead of counting hops. |
| **H8 / M1** | Add a per-user limiter across `/api/*`, with a lower ceiling on benchmark and analytics. |

### P2 — correctness and defence in depth

| ID | Action |
| :-- | :---- |
| **M14** | Add HSTS in production. |
| **M15** | Add a CSP to the Next.js app, starting report-only. |
| **M13** | Validate `WEB_ORIGIN` entries; reject `*` with credentials; require HTTPS in production. |
| **M5** | Replace `KEYS` with `SCAN`. |
| **M2** | Source the logs total from the CAGG or drop it for cursor pagination. |
| **M3** | Validate `keyId`/`serviceId` ownership before querying. |
| **M4** | Zero-fill chart buckets. |
| **M12** | Gate error detail on an explicit flag, not `NODE_ENV`. |

### P3 — polish

| ID | Action |
| :-- | :---- |
| **M10** | Add a breached-password check; raise the minimum length. |
| **M9** | Add CAPTCHA or proof-of-work on registration. |
| **M11** | Document that `safeEqualString` does not treat length as secret. |
| **L9** | Add retention and sampling to `api_key_events`. |
| **L15** | Wire up `destroyAllSessionsForUser` as a "sign out everywhere" action. |

---

## What is genuinely well done

Worth stating plainly, because it is unusual and it is the reason this audit found fewer severe issues than the codebase's size would suggest:

- **The template engine.** No `eval`, a closed faker allowlist, prototype-pollution guards at every step, own-property-only reads, depth caps, per-request Faker instances, and total failure containment. This is the part most projects get wrong and it is right here.
- **API key storage.** HMAC-SHA-256 with a server-side pepper, an indexed `publicId` for O(log n) lookup, `timingSafeEqual` with a dummy HMAC on miss, raw key shown exactly once, family-based kill switch, scopes that fail closed to `mock:read`. The reasoning for rejecting Argon2id on the hot path is documented and correct.
- **Login timing.** `DUMMY_HASH` verification on the no-user path, and a single generic 401 body for every key-verification failure mode so the response is not an oracle.
- **Path decoding.** The `mockParams()` workaround for Fastify/find-my-way double-decoding is subtle and correct.
- **Chaos socket drops.** `reply.hijack()` before `destroy()` is the right sequence.
- **Cache invalidation for tiers, routers, and chaos rules.** All three use pub/sub. The key cache is the one that was missed (M7), which makes the omission look like an oversight rather than a design gap.