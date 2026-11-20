# Feature Deep Dives

## 1. Sliding-window rate limiter

Files: `ratelimit/lua.ts`, `limiter.ts`, `tier.ts`, `middleware.ts`.

- One Redis **sorted set per organization** (`rate:org:<orgId>`), score = epoch ms, member = `<ms>:<random hex>`.
- A single Lua script (loaded via `SCRIPT LOAD`, called with `EVALSHA`, `NOSCRIPT` → reload) does, atomically: trim entries older than the window, `ZCARD`, then either `ZADD` + `PEXPIRE` (allowed) or compute `retry_after` from the oldest entry (denied). Time comes from Redis `TIME` unless a simulated now is passed (tests).
- Returns `[allowed, limit, remaining, reset_at, retry_after]`.
- Plan → limit: `floor(requestsPerWindow × burstAllowance)`. `free` = 100/h, `pro` = 5000 × 1.2 = 6000/h.
- Plan lookup: memory (30 s) → Redis (60 s) → Postgres, invalidated by `plan:changed` pub/sub, so upgrades apply without restart.
- Headers on 200s and 429s: `X-RateLimit-Limit/Remaining/Reset`, plus `Retry-After` on 429.
- Fails open if Redis is unreachable.
- Cost note: a sorted set stores one member per request in-window (O(N) memory per org).

## 2. Mock engine

Files: `mock/template.ts`, `seed.ts`, `services.ts`, `router.ts`, `openapi.ts`, `routes/mock.ts`, `routes/services.ts`.

- A **service** (slug) owns **routes** (method + path template with `:params`). Per service a `find-my-way` router is built and cached; changes invalidate the cache across instances via pub/sub.
- Responses are JSON templates. Expressions: `{{params.x}}`, `{{query.x "default"}}`, `{{body.x}}`, `{{faker.<ns>.<fn> k=v}}`, `{{now}}`.
- **Deterministic**: seed = f(org, service, request path), so the same URL always returns the same data for everyone in the org.
- Route-level `statusCode`, `responseHeaders`, `latencyMs`. `weightedResponses` is reserved for future use.
- Every org is seeded with an E-commerce service (`seed.ts`).
- OpenAPI 3.1 doc generated per service at `/docs/:slug/openapi.json`; the web app renders it with Stoplight Elements (`/docs`, `/dashboard/docs`).
- Path handling: `find-my-way` decodes paths itself, so the handler avoids double decoding (a past bug).

## 3. Chaos engineering

Files: `chaos/cache.ts`, `sampling.ts`, `middleware.ts`, `routes/chaos.ts`; UI `dashboard/chaos`.

- Rule scopes, most specific wins: (org, service, key) → (org, service) → (org, key) → (org). A specific rule with `isEnabled:false` **exempts** that scope from an org-wide rule.
- Applied after rate limiting, in order: **partition** (`reply.hijack()` + `request.raw.destroy()` — a real TCP drop), **latency** (fixed / uniform / Box-Muller normal, clamped 0–30 s), **errors** (429 simulated first, then 5xx picked from `statusCodes`, default 500/502/503/504).
- Resolution cache: 5 s local, 60 s Redis, invalidated by `chaos:invalidated` pub/sub. A failure to resolve a rule skips chaos rather than failing the request.
- The Resilience Studio page uses `/api/chaos/benchmark` to demonstrate the injected distribution (e.g. 5% error rate ≈ 5 failures per 100).

## 4. Analytics

Files: `analytics/ingest.ts`, `service.ts`, `types.ts`, `routes/analytics.ts`; UI `dashboard/analytics`.

- **Ingestion**: `recordRequestLog` pushes to an in-memory queue (no I/O on the request path). Flush on 100 rows or every 500 ms; each flush drains up to 200 rows; a flush marks touched orgs and invokes the quota check callback.
- **Storage**: `request_logs` hypertable; 30-day retention policy; hourly aggregate `usage_hourly` for p50/p95/p99, requests, errors, throttled.
- **Queries**: overview, usage, latency, errors, paginated logs (`TimeRange` like `24h`). The dashboard renders interactive SVG charts and paginated logs.

## 5. Quota webhooks

Files: `analytics/quotaMonitor.ts`, `webhooks.ts`.

- After ingestion, for each touched org count `request_logs` in the plan window and compare to the plan limit. At ≥ 80% and ≥ 100% fire a webhook once per threshold crossing (`last_alerted_threshold` dedupes and resets).
- Payloads signed with HMAC-SHA256 (`signPayload`). `POST /api/analytics/webhooks/:id/test` sends a test event.

## 6. Key lifecycle

Files: `keys/*`.

`generate` → `store` (HMAC hash, prefix, last4, family) → `verify` (cache → indexed lookup → timing-safe compare, grace-window logic) → `touch` (batched `last_used_at`) → `audit` (events with IP) → `rotate` (new key in same family, old key valid for `graceHours`) → `revoke` / family revoke. `redact.ts` scrubs key-shaped strings from logs.

## 7. Time-Travel Playground

Files: `playground/{runner,store,internalAuth,janitor}.ts`, `playground/export/*`, `routes/playground.ts`, shared `diff.ts`; UI `dashboard/playground` and `components/playground/*`.

- **Same pipeline as an external call.** The runner uses `fastify.inject()` against `/mock/<slug>/<path>`, so key auth, scopes, the org rate limit, chaos and telemetry all apply (playground traffic counts against quota and shows in analytics). There is no network hop and no free-form URL, so no SSRF surface.
- **No raw keys.** Keys are never stored, so the runner presents a per-boot random token (`x-throttlebox-internal`, compared in constant time) plus a key id. `requireKeyAuth` accepts that pair and builds the auth context with `loadKeyContextById`, which still fails closed on revoked, expired and grace-elapsed keys and reads the database rather than the cache. Anyone without the token falls through to the normal bearer path.
- **Capture.** Method, path, query, headers, body, response status/headers/body, duration and outcome. A chaos network partition shows up as `outcome: dropped` immediately (`inject()` rejects with "response destroyed before completion").
- **Replay and fork.** Replay re-runs a stored request (optionally with another key) and links `parent_id`. Fork pre-fills the builder from a stored request. Because mock data is deterministic, any difference between a request and its replay comes from something you changed — chaos, a template edit, a plan change.
- **Diff.** `diffJson` / `diffRuns` in `@throttlebox/shared` compare status, outcome, headers (volatile ones like `date` and `x-ratelimit-remaining` are ignored by default) and body, with added/removed/changed paths. The UI renders it side by side; replaying auto-selects the original and the replay.
- **Export.** `toVitest` writes a self-contained file importing only `vitest`, reading `THROTTLEBOX_API_KEY` and `THROTTLEBOX_BASE_URL` from the environment (a secret is never written to the file). Each request becomes a test asserting status, response shape and exact body (deterministic data makes this safe). Captures taken under a chaos fault, rate limit or dropped socket are exported as `it.skip` unless `includeFaults=true`. The `Content-Type: application/json` default the runner applies to bodies is written out explicitly so the exported test behaves identically. `toPostman` writes a Collection v2.1 with `{{baseUrl}}` and `{{apiKey}}` variables.

## 8. Web app

Next.js App Router pages: `/` landing, `/login`, `/docs` (public API reference), and the authenticated dashboard (`layout.tsx` shell): overview, **keys** (one-time reveal modal), **services** (route editor + preview), **rate-limits** (plan/usage), **analytics**, **chaos** (sliders + resilience studio), **playground** (builder, timeline with replay/fork, response viewer, side-by-side diff, export), **docs**. Data fetching via TanStack Query through `lib/api.ts`.
