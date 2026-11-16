# Throttlebox — Phase-wise Bug Report

**Date:** 2026-11-16
**Commit audited:** `0b564ea` (main)
**Scope:** every phase marked done in `PHASES.md` (0–6), across `apps/server`, `apps/web`, `packages/shared`, migrations, CI and config.

## How this was checked

- I read every server source file, every migration, the shared package, and every dashboard page.
- I ran these checks locally:
  - `pnpm typecheck`: server and shared pass. **Web fails with 7 errors.**
  - `pnpm lint`: passes.
  - `pnpm format:check`: **fails on 53 files.**
- I ran a throwaway Vitest probe to confirm the router crash (3.2), the template DoS (3.1), header echo (3.3), the OpenAPI path format and missing `security` (3.7, 3.8) and the SSRF bypasses (5.12). I deleted the probe afterwards. The observed output is quoted next to each of those bugs.
- I could **not** run the Postgres/Redis integration tests, because Docker is not running on this machine. Bugs that depend on the database come from reading the code. Each one names the file and line so it can be checked.

**Severity:** 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low.
**[known]** means the bug is already in `SECURITY_AUDIT_2026_11_16.md`. It is listed here briefly so the report is complete. Everything else is new.

---

## Fix status (2026-11-16, second pass)

The fixes were made in the working tree and verified against a real TimescaleDB and Redis (Docker):

| Check                                          | Result                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`                            | passes (it failed on 53 files)                                                                                                                         |
| `pnpm typecheck`                               | passes in all packages (web failed with 7 errors)                                                                                                      |
| `pnpm lint`                                    | passes                                                                                                                                                 |
| `pnpm build`                                   | passes                                                                                                                                                 |
| `pnpm test`                                    | **246 server + 8 shared tests pass**, up from 189. 54 of them are new regression tests in `apps/server/tests/regressions/`, one or more per fixed bug. |
| `drizzle-kit migrate` on the existing database | applies 0005–0007. `chaos_rules` exists, `request_logs` has no FKs, `usage_hourly` is real-time, and the refresh and retention jobs are scheduled.     |
| Smoke test of the built server                 | register → key → mock call → OpenAPI → plan usage → logout all behave correctly                                                                        |

**Fixed:**

- **0:** 0.1, 0.2, 0.3, 0.4 (corrected above), 0.5, 0.6, 0.7, 0.9, 0.10
- **1:** 1.1–1.10, 1.13–1.16
- **2:** 2.1, 2.3–2.13
- **3:** 3.1–3.8, 3.9, 3.10–3.20, 3.21, 3.22–3.25
- **4:** 4.1, 4.6, 4.7, 4.8
- **5:** 5.1–5.23
- **6:** 6.1–6.3, 6.5–6.10, 6.13 (Postgres-backed chaos route tests added)
- **7:** 7.3, 7.4

**Partly fixed:**

| Bug  | What changed                                                                  | What is left                                              |
| ---- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1.12 | The auth limiter now runs on Redis, with separate login and register budgets. | Successful logins still count toward the limit.           |
| 3.16 | The preview accepts a query string.                                           | The UI still has no request-body field for POST previews. |
| 6.4  | The UI now calls the benchmark a simulation.                                  | It still does not send real requests.                     |
| 6.11 | The latency slider now goes to 5 s.                                           | There is no UI for per-service or per-key rules.          |

**Not fixed, and why:**

| Bug      | Reason                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| 0.8      | Pinning the TimescaleDB image to an older tag could break the existing local data volume. Pick a tag deliberately. |
| 1.11     | Self-serve upgrades to Pro are a business decision, not a code fix.                                                |
| 4.2      | One bucket per org is intended (the quota is the org's), and is now documented in the code.                        |
| 4.3      | Burst semantics are unchanged; only the UI copy was corrected.                                                     |
| 4.4      | The `plans` table is still unused, but the duplicate `PLAN_LIMITS` constant is gone.                               |
| 4.5      | The 60 s plan-cache race is low impact.                                                                            |
| 6.12     | Rule precedence is unchanged.                                                                                      |
| 6.14     | The uniform-distribution semantics are unchanged.                                                                  |
| 7.1, 7.2 | Deployment architecture is Phase 9 work.                                                                           |

**Withdrawn:** 2.2 (intended behaviour, see above).

**Note on 3.3:** `{{headers.user-agent}}` never worked. Template paths only allow `[A-Za-z0-9_]`, so headers containing a dash cannot be read at all. Only dash-free headers such as `accept` are addressable.

---

## Top 10 — fix these first

| #   | Phase | Bug                                                                                                                                                      | Sev        |
| --- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | 5/6   | Migrations `0005` and `0006` are not in `_journal.json`, so they never run. There is no `chaos_rules` table, no aggregate refresh and no retention.      | 🔴         |
| 2   | 5     | One bad row (for example, a log for a deleted service) blocks analytics ingestion permanently.                                                           | 🔴         |
| 3   | 5     | `flushAll()` busy-loops on shutdown. The process hangs at 100% CPU.                                                                                      | 🟠         |
| 4   | 3     | A template such as `{{faker.string.alpha 20000000}}` blocked the event loop for **21.7 s** (measured).                                                   | 🟠         |
| 5   | 1     | The CSRF cookie is cleared when the browser closes, but the session cookie lasts 7 days. Every mutation then fails with 403, including login and logout. | 🟠         |
| 6   | 1     | A session never expires while it is used. The Redis TTL slides and the absolute expiry is never checked.                                                 | 🟠         |
| 7   | 3     | Routes `/x` and `/x/` crash the service router, so every request to that service returns 500 (confirmed).                                                | 🟠         |
| 8   | 5     | SSRF bypasses: `fd12::/16`, `::ffff:127.0.0.1`, `::`, `*.nip.io` and redirects all pass the URL check (confirmed).                                       | 🟠 [known] |
| 9   | 0     | CI is red. `format:check` fails on 53 files, and web typecheck fails.                                                                                    | 🟠         |
| 10  | 3/4   | Every mock request makes at least 2 Postgres queries (`getServiceBySlug`), which breaks the "<5 ms overhead" goal.                                       | 🟡         |

---

## Phase 0 — Foundation

**0.1 — CI is red: Prettier check fails on 53 files** 🟠
`.github/workflows/ci.yml:76` runs `pnpm format:check` before typecheck and tests. Locally it reports _"Code style issues found in 53 files"_. Most of the dashboard pages, most of the tests, `packages/shared/src/index.ts`, `package.json` and the markdown docs are unformatted.
This is not only CRLF noise from this Windows checkout (`core.autocrlf=true`). I ran the committed LF content through Prettier:

- `config.ts` (the control) matches;
- `server/src/index.ts`, `routes/chaos.ts`, `analytics/service.ts`, `web/lib/api.ts`, `dashboard/chaos/page.tsx` and `shared/src/index.ts` do **not**.

So CI on `main` fails at this step, and the later steps (typecheck, build, tests) never run.
**Fix:** run `pnpm format` and commit. Add `.gitattributes` with `* text=auto eol=lf` as well.

**0.2 — Web typecheck fails (7 errors in typed routes)** 🟠
`apps/web` uses `typedRoutes: true` (`next.config.ts:7`). `tsc` rejects `href="/dashboard/rate-limits"`, `/dashboard/docs`, `/dashboard/analytics` and `/dashboard/chaos` in `dashboard/layout.tsx:287,305,338,401`, `dashboard/page.tsx:290,353` and `services/page.tsx:253`.
The route types under `.next/types` are stale: they predate the new pages. CI runs `typecheck` _before_ `build` (`ci.yml:79-86`), so on a fresh checkout the typed-route types do not exist yet.
**Fix:** generate route types before typecheck (`next typegen` or `next build`), or run typecheck after build.

**0.3 — Shutdown order loses data** 🟡
In `apps/server/src/index.ts:94-104`, the ingest and touch flushers are stopped _before_ `fastify.close()`. Requests still in flight finish after the flush, and their `request_logs` rows and `last_used_at` updates are lost.
There is also no shutdown timeout. Combined with 5.3, SIGTERM can hang forever.
**Fix:** call `fastify.close()` first so in-flight requests drain, then flush. Wrap the whole shutdown in a hard timeout.

**0.4 — Turbo strips the server's runtime env vars** 🟡 _(corrected after checking the turbo 2.11 docs)_
My first version of this said `NEXT_PUBLIC_API_URL` was missing from the build hash. That was wrong: Turborepo's Framework Inference already hashes `NEXT_PUBLIC_*` for Next.js packages.
The real problem is the opposite one. Turbo runs in Strict Mode by default and removes any variable that is not listed in `turbo.json` from the task's environment. `turbo.json:4` listed only `NODE_ENV`, `DATABASE_URL` and `REDIS_URL` (plus the two secrets as pass-through). So when a platform sets `WEB_ORIGIN`, `COOKIE_DOMAIN`, `TRUST_PROXY_HOPS` or `PORT` and runs `pnpm start` (which is `turbo run start`), the server never sees them and silently falls back to defaults, for example `COOKIE_DOMAIN=localhost`.
**Fix:** add them to `globalPassThroughEnv`.

**0.5 — `WEB_ORIGIN` bypasses the Zod config** 🟢
`index.ts:48` reads `process.env.WEB_ORIGIN` directly. It is not validated, not trimmed (`"a, b"` produces the origin `" b"`), and missing from `.env.example`. [known M13]

**0.6 — `isDirectRun` heuristic** 🟢
`index.ts:118` uses `process.argv[1]?.includes('index')`. Any entry path that contains "index" auto-starts the server, and renaming the file silently stops it.
**Fix:** compare `import.meta.url` with `pathToFileURL(process.argv[1])`.

**0.7 — Redis client blocks requests when Redis is down** 🟢
`db/redis.ts:4-7` sets `maxRetriesPerRequest: 3` and keeps the offline queue. The "fail-open" paths (rate limiter, key cache, chaos) each wait through the retries first, so a Redis outage adds seconds to every request instead of failing fast.

**0.8 — Unpinned images** 🟢
`docker-compose.yml:5` and `ci.yml:24` use `timescale/timescaledb:latest-pg16`. A Timescale release can change continuous-aggregate defaults with no code change (see 5.7).

**0.9 — Hard-coded health version** 🟢
`http/health.ts:21` returns `version: '0.1.0'`, which will drift from `package.json`.

**0.10 — Dead env var** 🟢
`.env.example:11` defines `API_URL`, but nothing reads it.

---

## Phase 1 — Auth & Organizations

**1.1 — CSRF cookie outlives nothing; users get locked out** 🟠
In `routes/auth.ts:146-150,209-214`, the session cookie gets `expires: session.expiresAt` (7 days). The CSRF cookie (`csrfCookieOptions`, `auth.ts:37-43`) has **no** `expires`, so it is a browser-session cookie.
After the browser restarts, the session cookie is still there but the CSRF cookie is gone. The CSRF hook (`auth/middleware.ts:120-139`) runs whenever a session cookie is present, so every POST/PATCH/PUT/DELETE returns `403 csrf_failed`. That includes `/auth/logout`, and `/auth/login` itself.
The user cannot sign out or back in until they clear cookies by hand.
**Fix:** give the CSRF cookie the same `expires` as the session cookie. Also exempt `/auth/login` and `/auth/logout` from CSRF, or re-issue the CSRF cookie from `/me` whenever it is missing.

**1.2 — Sessions never expire while in use** 🟠
`auth/session.ts:95-98`: on every Redis hit, `redis.expire(..., SESSION_TTL_SECONDS)` resets the TTL to 7 days, and the Postgres `expires_at` is never checked.
The janitor deletes the database row after 7 days, but the Redis entry keeps sliding. A stolen token that is used at least once a week works forever. Only the cookie `expires` limits an honest browser.
**Fix:** store `expiresAt` in the Redis record and reject the session when it has passed. Cap the TTL at the remaining absolute lifetime instead of resetting it.

**1.3 — Logout does not clear cookies in production** 🟡
`routes/auth.ts:225` calls `clearCookie(name, { path: '/' })`. In production the cookies were set with `domain: COOKIE_DOMAIN` (`auth.ts:28,42`), and a clear without the same domain does not match them. The browser keeps both cookies. The server session is destroyed, but the browser keeps sending a dead token.
**Fix:** pass the same `domain`, `secure` and `sameSite` options to `clearCookie`.

**1.4 — Role and org cached in the session for its whole life** 🟠 [known H3]
`auth/middleware.ts:47-74` and `session.ts:66-72`. A user who is demoted or removed keeps their old permissions.

**1.5 — Users with no org hit Postgres on every request** 🟢
`auth/middleware.ts:51-74`: the warm-up only writes back `if (orgId && role)`. A user with no membership runs the `org_members` query on every request, forever.
**Fix:** cache the "no membership" result as well.

**1.6 — Registration race returns 500** 🟢
`routes/auth.ts:94-131` checks for the email and then inserts. Two concurrent registrations with the same email both pass the check, and the second hits `users_email_lower` and returns 500 instead of 409.
**Fix:** catch SQLSTATE `23505` and return 409.

**1.7 — A failed seed leaves a half-registered user** 🟢
`routes/auth.ts:133-143`: `seedFlagshipService` runs after the transaction and after the session is created. If it throws, the client gets 500 and no cookie, but the user, org and session all exist. Retrying registration then gets 409 "email taken".
**Fix:** seed inside the transaction, or make it best-effort with a log.

**1.8 — Bad workspace name** 🟢
`routes/auth.ts:116`: `name.split(' ')[0] ?? name` never falls back, because `split` always returns at least `['']`. For a name like `" Ada"` the org is named `"'s Workspace"`. `registerSchema.name` (`auth.ts:15`) does not trim, so a name of `"   "` is accepted.
**Fix:** use `z.string().trim().min(1)` and `name.trim().split(/\s+/)[0] || name`.

**1.9 — CSRF skipped for any `Authorization` header** 🟢
`auth/middleware.ts:122` skips CSRF whenever an `Authorization` header is present. But `request.auth` is still filled from the cookie, so a request carrying `Authorization: x` plus the session cookie is cookie-authenticated with no CSRF check.
Browsers block this cross-site through the CORS preflight, so it is not exploitable today. It is a fragile assumption, though.
**Fix:** when a bearer token is present, ignore the cookie (set `request.auth = null`).

**1.10 — Login CSRF** 🟢
`/auth/login` with no existing session cookie skips CSRF (`middleware.ts:125`). A third-party site can log a victim into the attacker's account.
**Fix:** use a pre-session CSRF token, or check the `Origin` header on auth routes.

**1.11 — Anyone can self-upgrade to Pro** 🟡
`routes/org.ts:23-45`: `PATCH /api/org/plan` lets any owner or admin switch to `pro` instantly, with no billing or approval step. The UI shows "Upgrade" buttons that call it directly (`dashboard/page.tsx:46-49`, `rate-limits/page.tsx:61`).
That is fine for a demo, but it is a business-logic hole if the tiers are meant to mean anything.

**1.12 — Auth limiter quirks** 🟢 [known H2]
`http/rateLimit.ts`: the limiter is per-process. Successful logins count toward the limit, and register and login share one bucket per IP, so a busy office NAT locks everyone out.

**1.13 — `MeResponse.org` typed non-null** 🟢
`packages/shared/src/index.ts:117-125` declares `org` as always present, but `/me` returns `org: null` when there is no membership (`routes/auth.ts:243`). The frontend type lies.

**1.14 — Dead helper** 🟢
`http/errorHandler.ts:38`: `isValidationError` is never used. A thrown `ZodError` becomes a 500.

**1.15 — "Already authenticated… Redirecting" never redirects** 🟢
`web/src/app/login/page.tsx:48-84` shows the message but never calls `router.push`.

**1.16 — Misleading security copy** 🟢
`login/page.tsx:496` says "Encrypted HTTP-only cookies with strict SameSite". The cookies are not encrypted and use `sameSite: 'lax'`.

---

## Phase 2 — API Keys

**2.1 — Concurrent rotations leave two "current" keys** 🟡
`keys/store.ts:276-323`. Two rotations of the same key at once each insert a successor. Each UPDATE retires "current keys except mine", but under READ COMMITTED it cannot see the other transaction's uncommitted successor. Both successors end up with `grace_until = NULL`, which breaks the "one current key per family" rule the comment promises.
**Fix:** `SELECT … FOR UPDATE` on the family row first, or add a partial unique index `(family_id) WHERE status='active' AND grace_until IS NULL`.

**2.2 — Rotating a superseded key retires the real current key** ⚪ _(withdrawn: intended behaviour)_
`store.ts:249-260` only rejects revoked keys, so you can rotate an old key that is already in its grace window. That mints a new successor and puts the previous current key into grace.
I first treated this as a bug. The existing tests (`keys.test.ts`, "retires the intermediate key when the same key is rotated twice") show it is the intended design: rotating any key in a family makes the new key the only current one. The real defect here was the race in 2.1, which is now fixed.

**2.3 — Rotating an expired key mints a dead successor** 🟢
`store.ts:290` copies `expiresAt: existing.expiresAt`. If the key is already expired, the new key is born expired and the UI still shows the reveal.
**Fix:** reject rotation of expired keys, or reset the expiry.

**2.4 — Unknown public IDs hit Postgres every time** 🟡
`keys/verify.ts:43-70`: a miss is never cached. An unauthenticated client sending random well-formed `sk_test_<12>_<32>` keys costs one Postgres query each, and the rate limiter runs only _after_ auth (`routes/mock.ts:259-264`).
**Fix:** cache misses briefly, and put a cheap per-IP limit before `requireKeyAuth`.

**2.5 — Wrong secret = one audit INSERT** 🟡 (documented in `audit.ts:59-67`)
Anyone who knows a public ID (it is shown in logs and the UI) can write rows to `api_key_events` without limit.

**2.6 — Revoked key stays valid up to 60 s on other instances** 🟡 [known M7]
`keys/cache.ts`: there is no pub/sub, and `invalidate*` errors are swallowed.

**2.7 — Stale comment** 🟢
`store.ts:351-357` says _"there is no cache to invalidate yet"_, but the function does invalidate the cache on lines 394-395.

**2.8 — Family revoke leaves `cache:key:id:*` entries behind** 🟢
`cache.ts:96-108`. They are harmless, but they leak until their TTL expires.

**2.9 — UI: key status ignores expiry and grace** 🟢
`web/.../keys/page.tsx:220-240` shows `active` for expired keys. Any key with `graceUntil` set shows "rotating (24h grace)", even when the grace was custom or already over and the key is dead.

**2.10 — UI: kill switch not exposed** 🟢
`api.revokeFamily` (`lib/api.ts:138`) is never called. The family kill switch from the Phase 2 plan has no button.

**2.11 — UI: empty table shown while loading** 🟢
`keys/page.tsx:172`: while `isLoading`, the condition falls through to the table branch, so the loader and an empty table render together.

**2.12 — UI: "Active Keys" counts revoked keys** 🟢
`dashboard/page.tsx:98` shows `keys.length` instead of the number of keys with `status === 'active'`.

**2.13 — UI: whitespace key name** 🟢
`keys/page.tsx:412` trims after the browser's `required` check, so `"   "` passes in the browser and the server returns 400.

---

## Phase 3 — Mock Engine

**3.1 — Template DoS: unbounded Faker arguments** 🟠 _(confirmed)_
`mock/template.ts:179-188,256-261` passes numeric arguments to Faker with no bounds.
Observed: `renderTemplate('{{faker.string.alpha 20000000}}')` produced a 20 MB string and took **21,728 ms**, all of it synchronous. During that time the whole server (every tenant, health checks, everything) is frozen. `faker.lorem.paragraphs 1000000` and similar calls behave the same.
Any user with `mock:write` can do this, and so can any caller who hits a route that contains such a template.
**Fix:** clamp numeric arguments (for example ≤ 1,000), cap the rendered body size, and cap how many expressions a template can contain.

**3.2 — Trailing-slash duplicate crashes the whole service** 🟠 _(confirmed)_
`mock/services.ts:330-349` checks uniqueness on the raw path. `mock/router.ts:38-74` normalizes `/products/` to `/products` before `router.on`. With both routes stored, building the router throws:

> `Method 'GET' already declared for route '/products' with constraints '{}'`

The error happens inside `getServiceRouter`, so **every** request to that service returns 500 until one route is deleted. The same happens for any path `find-my-way` cannot parse, for example `/a/*/b` ("Wildcard must be the last character") or `/a/:id(` (an invalid regexp). My first version gave `/a/:` as the example; `find-my-way` actually accepts that one.
**Fix:** normalize the path before the uniqueness check and before storing it. Validate the path by building a throwaway router in `createRoute` and `updateRoute`.

**3.3 — `{{headers.*}}` exposes credentials** 🟡 _(confirmed)_
`routes/mock.ts:163` passes the raw request headers into the template context.

- On the public API, `{{headers.authorization}}` echoes the caller's API key into the response body, where proxies and logs may record it.
- In the **dashboard preview**, the headers are the logged-in user's, so `{{headers.cookie}}` renders the httpOnly session token into JSON that page JavaScript can read. The probe printed `throttlebox_session=SECRET`. A `dev` member can plant this in a route and wait for an owner to preview it.

**Fix:** allowlist safe headers, and always strip `authorization`, `cookie` and `x-csrf-token`.

**3.4 — Response header names unvalidated** 🟡
`routes/services.ts:29` only validates the header _values_ (`z.record(z.string().max(200))`).

- A name with a space or a non-token character makes `reply.header` throw when the response is sent, and the route returns 500.
- Names like `Content-Length`, `Transfer-Encoding` and `Set-Cookie` are accepted and can corrupt responses.

**Fix:** validate names against the RFC 7230 token pattern and deny hop-by-hop and framing headers.

**3.5 — Response headers are not templated** 🟢
The seeded `POST /orders` sets `Location: '/mock/ecommerce/orders/{{params.id}}'` (`mock/seed.ts:168`). Headers are copied raw (`routes/mock.ts:244-246`), so callers get the literal `{{params.id}}`. Even if headers were templated, `POST /orders` has no `:id` parameter.

**3.6 — Custom Content-Type is always overwritten** 🟢
`routes/mock.ts:252` calls `.type('application/json')` after the custom headers, so a route can never return XML, text or CSV.

**3.7 — OpenAPI uses `:id` instead of `{id}`** 🟡 _(confirmed)_
`mock/openapi.ts:85` emits the path `/products/:id`. OpenAPI path templates use `{id}`, so the document declares a path parameter that does not appear in the path. Stoplight "Try it", Postman import and SDK generators all mishandle it.
**Fix:** convert `:name` to `{name}` when building `paths`.

**3.8 — OpenAPI has no `security` requirement** 🟡 _(confirmed)_
`openapi.ts:88-106` defines `bearerAuth` but never applies it, either globally or per operation. Generated clients never send the key.
**Fix:** add `security: [{ bearerAuth: [] }]` at the top level.

**3.9 — OpenAPI ignores the route summary** 🟢
`openapi.ts:45` sets `summary: route.path`. `RouteDefinition` has no summary or description, so what the author wrote never reaches the document.

**3.10 — OpenAPI endpoint is unthrottled and ignores scope** 🟢
`routes/openapi.ts:15-23` accepts any valid key, even one with no `mock:read`. Each call verifies the key and runs two Postgres queries, outside the rate limiter.

**3.11 — Router cache still costs a database query per request** 🟡
`mock/services.ts:308-320`: `getServiceRouter` always runs `getServiceBySlug` (Postgres) before checking the cache, because the cache is keyed by service id. It runs once in the chaos hook (`chaos/middleware.ts:53`), again in the handler (`routes/mock.ts:115`), and a third time in telemetry if `mockServiceId` is missing. That is 2–3 database round trips on every mock call, which contradicts the "<5 ms p95 overhead" exit criterion.
**Fix:** cache by `(orgId, slug)`, or keep a slug-to-id map and invalidate it on service update or delete.

**3.12 — Router cache race keeps a stale router forever** 🟢
`services.ts:312-317`. Request A reads the old route definitions, then an edit invalidates the cache, then A writes its old router back. The cache has no TTL, so the stale routes stay until the next edit.
**Fix:** add a version counter or a short TTL.

**3.13 — Service slug can become empty** 🟢
`services.ts:236`: `updateService` with `slug: "!!!"` slugifies to `''` and is saved, which makes the service unreachable. `createService` checks for this (`services.ts:205`); `updateService` does not. Neither function catches a `23505` from a concurrent duplicate slug, so a race returns 500.

**3.14 — Seeding is not atomic** 🟢
`mock/seed.ts:226-264` inserts the service and then the routes without a transaction. If the routes insert fails, the org gets an empty seeded service. It can never be deleted (`isSeeded`, `services.ts:262`) and is never re-seeded, because `existing` short-circuits.

**3.15 — Pagination does not change data** 🟢
`routes/mock.ts:171`: the seed is `seedFrom(orgId, slug, method, path)` and excludes the query string, so `?page=2` returns exactly the same products as page 1. The seed also returns `X-Total-Count: 42` alongside 3 items (`seed.ts:36`).

**3.16 — Preview ≠ real response** 🟢
`routes/mock.ts:316-324` and `services/page.tsx:616-622`. The preview cannot send a query string, uses the dashboard's headers, and the UI never sends a body for POST/PUT. The path seeds can also differ: the caller's path is percent-encoded, while the preview uses whatever was typed.

**3.17 — `/mock/<slug>` with no sub-path returns Fastify's 404** 🟢
`routes/mock.ts:24` uses the pattern `/mock/:serviceSlug/*`. The bare slug gets the generic Fastify 404 instead of a JSON service response.

**3.18 — Trace IDs collide** 🟢
`routes/mock.ts:207` uses Fastify's `request.id` (`req-1`, `req-2`, …). The counter resets on restart and is the same on every instance.
**Fix:** use `genReqId: () => randomUUID()`.

**3.19 — UI: deleting a seeded service fails silently** 🟢
`services/page.tsx:452-456` shows "Delete Service" for the seeded E-commerce service. The server returns 400, the `mutateAsync` rejection is unhandled, and the modal shows no error.

**3.20 — UI: status badge always says "OK"** 🟢
`services/page.tsx:377` shows `{statusCode} OK`, so a 404 route reads "404 OK".

**3.21 — UI: route form is incomplete** 🟢
`services/page.tsx:715-844` has no fields for latency, response headers, active/inactive or description. Inactive routes also have no visual indicator.

**3.22 — UI: the docs curl example uses a literal `:id`** 🟢
`dashboard/docs/page.tsx:298` builds `…/products/:id`, which calls the route with `id=":id"`.

**3.23 — Stoplight loaded unpinned from unpkg, no SRI** 🟡
`dashboard/docs/page.tsx:84,93` load `https://unpkg.com/@stoplight/elements/...` with no version and no integrity hash. Any new upstream release, or a compromised one, runs in the dashboard origin with the user's session.
**Fix:** pin a version and add `integrity`, or install it as an npm dependency.

**3.24 — Download revokes the blob URL too early** 🟢
`dashboard/docs/page.tsx:114-115` calls `URL.revokeObjectURL` right after `click()`, which can cancel the download in some browsers.

**3.25 — Copy says "Handlebars"** 🟢
`services/page.tsx:637`. The engine is not Handlebars.

---

## Phase 4 — Rate Limiting

**4.1 — Chaos 429s count as real throttling** 🟡
`routes/mock.ts:206` sets `rateLimited = reply.statusCode === 429`. A chaos-injected 429 (`chaos/middleware.ts:106`) is therefore stored as `rate_limited = true`. The overview's "Throttled", the usage series and the errors breakdown (`analytics/service.ts:27,105,174`) all mix fake 429s with real ones.
**Fix:** have `rateLimitMock` set a request flag and log that flag instead of the status code.

**4.2 — One bucket per org; `keyId` is ignored** 🟢
`ratelimit/middleware.ts:31-36` always passes `orgId`, so `limiter.ts:39` never uses the `rate:key:` bucket. One noisy CI key can starve every other key in the org. If that is intended, delete the dead path. If not, add per-key limits.

**4.3 — "Burst" is just a bigger limit** 🟢
`middleware.ts:29` computes `floor(requests × burstAllowance)`, so Pro simply gets 6,000/hour. There is no short-term burst behaviour, although the UI and copy describe one.

**4.4 — `plans` table is never read** 🟢
Migration `0003` creates and seeds `plans`, but `ratelimit/tier.ts` uses the `PLAN_CONFIGS` constant. Shared also defines the same numbers twice (`PLAN_CONFIGS` and `PLAN_LIMITS`, `shared/src/index.ts:53-76`). Editing the table does nothing.

**4.5 — Plan cache race** 🟢
`tier.ts:168-188`: `updateOrgPlan` invalidates the cache, but a concurrent `getOrgPlan` that read the database before the update can write the old plan back into Redis for 60 s.

**4.6 — UI claims things the server doesn't do** 🟢
`rate-limits/page.tsx:239-240` lists an `X-RateLimit-Policy` header, which is never sent. Line 55 promises "microsecond precision", but the limiter works in milliseconds. "requests / 3600 seconds" is hard-coded at line 120 rather than taken from `plan.windowSeconds`.

**4.7 — Hard-coded `localhost:3001` in the curl example** 🟢
`rate-limits/page.tsx:46` ignores `NEXT_PUBLIC_API_URL`, unlike the services page.

**4.8 — Fake quota bar and a broken arrow** 🟢
`dashboard/layout.tsx:328` hard-codes the quota bar at 35% for Free and 85% for Pro, whatever the real usage is. Line 341 renders `'Upgrade &rarr;'` inside a JS string, so the page shows the literal text `&rarr;`. Line 398 always says "Redis & Fastify Online".

---

## Phase 5 — Analytics & TimescaleDB

**5.1 — Migration `0005_timescale_policies.sql` never runs** 🔴
`apps/server/drizzle/meta/_journal.json` lists only entries 0–4. `drizzle-kit migrate` applies only journaled migrations, so `0005` (and `0006`, see 6.1) are skipped on every fresh database, including CI. The consequences:

- There is no continuous-aggregate refresh policy, and `usage_hourly` is created `WITH NO DATA`, so it stays empty.
- There is no 30-day retention, so `request_logs` grows without bound. `SECURITY_AUDIT` H5 assumes this retention exists. It does not.
- There are no `0005`/`0006` snapshots, so the next `db:generate` will emit `chaos_rules` again as a new migration and conflict.

**Fix:** regenerate properly with `drizzle-kit generate --custom` so both files get journal entries and snapshots. Then confirm with `select * from __drizzle_migrations`.

**5.2 — One poison row stops all ingestion forever** 🔴
`analytics/ingest.ts:56-89`: a whole batch goes into one `INSERT`. If any row breaks a foreign key, the batch fails, is put back at the **front** of the queue, and fails again on every later attempt.
`request_logs` has FKs to `api_keys`, `orgs` and `mock_services`. Examples that trigger it:

- deleting a mock service while its logs are still queued (`deleteService`, `services.ts:266`);
- deleting an org.

From then on no row is ever written. The queue fills to 10,000 and starts dropping data. Analytics is dead until the process restarts.
**Fix:** remove the FKs from the hypertable ([known H5] gives the reason). Also, on failure, split the batch or drop the failing rows rather than retrying the same batch forever.

**5.3 — `flushAll()` busy-loops, so shutdown hangs** 🟠
`ingest.ts:101-106`: `while (queue.length > 0) await flushQueue()`. If a timer-driven flush is already running (`isFlushing`), `flushQueue()` returns an already-resolved promise straight away. The loop then spins on microtasks and never yields to the event loop, so the database I/O that would finish that flush can never run.
The result is 100% CPU and a SIGTERM that never completes (`index.ts:96`). The flusher runs every 500 ms, so this is easy to hit. If the database is down at shutdown, the loop is infinite even without the race.
**Fix:** await the in-flight flush promise, add a bounded attempt count, and add a deadline.

**5.4 — Tight retry loop while the database is down** 🟡
`ingest.ts:90-95`: after a failure, `finally` starts another flush straight away whenever ≥100 rows are queued. During an outage the process hammers Postgres with no backoff.

**5.5 — Overflow drops the newest rows, not the oldest** 🟢
`ingest.ts:86-89`: `queue.splice(MAX_QUEUE_SIZE)` removes from the **tail**. The comment says "drop oldest", and `recordRequestLog` (line 28) does drop the oldest. The two paths disagree.

**5.6 — Batch size is 200, not 100** 🟢
`ingest.ts:56` uses `splice(0, BATCH_SIZE * 2)`, but `PHASES.md` and the constants say 100 rows.

**5.7 — Charts lose the latest hour once aggregates refresh** 🟡
`analytics/service.ts:57-91`. Once 5.1 is fixed, the refresh policy uses `end_offset => '1 hour'`, so the newest hour is never materialized. Recent TimescaleDB versions also default to `materialized_only = true`.
The aggregate query then returns rows (older hours), the `caggRows.length > 0` check passes, and the raw fallback never runs. The 24h, 7d and 30d charts silently leave out the most recent and most important data.
**Fix:** union the aggregate (older than the watermark) with raw `request_logs` (newer), or set `timescaledb.materialized_only = false`.

**5.8 — Invalid `keyId`/`serviceId` returns 500** 🟢
`routes/analytics.ts:52-56` passes query strings straight into a `uuid` comparison, so a non-UUID value raises a Postgres cast error and a 500. The IDs are also not checked for ownership [known M3].

**5.9 — `limit=abc` returns 500** 🟢
`routes/analytics.ts:98-99`: `parseInt` gives `NaN`, and `Math.min(Math.max(NaN, 1), 100)` stays `NaN` (`service.ts:216`), so the query runs `LIMIT NaN` and fails.
**Fix:** validate with `z.coerce.number().int()`.

**5.10 — Webhook ID routes are unvalidated** 🟢
`routes/analytics.ts:150-172`: a non-UUID `:id` returns 500. `DELETE` returns `{ success: true }` for a webhook that does not exist.

**5.11 — Webhook secret visible to `viewer`** 🟠 [known C2]
`analytics/webhooks.ts:116` returns the secret through `GET /analytics/webhooks`, which only needs `analytics:read`.

**5.12 — SSRF filter bypasses** 🟠 [known C1/C3] _(confirmed)_
`isValidWebhookUrl` (`webhooks.ts:49-106`) returned `valid: true` for:

- `http://[fd12:3456::1]/`: only the `fd00:` prefix is checked, not the whole of `fc00::/7`;
- `http://[::ffff:127.0.0.1]/`: IPv4-mapped loopback;
- `http://[::]/`;
- `http://[fec0::1]/`;
- `http://127.0.0.1.nip.io/`: DNS is never resolved.

`fetch` follows redirects by default (`webhooks.ts:194`), and the test endpoint returns the error text, which makes it a port-scan oracle.
**Fix:** resolve DNS and check every resulting address, pin the connection to the checked IP, set `redirect: 'manual'`, and return only generic errors.

**5.13 — Duplicate quota alerts** 🟡
`ingest.ts:75-81` fires `quotaCheckCallback` without awaiting it, so overlapping flushes run `checkSingleOrgQuota` at the same time. Each reads `lastAlertedThreshold = null` before either updates it (`quotaMonitor.ts:52-69`), and both send the 80% webhook. Several instances make this worse.
**Fix:** use a conditional update (`UPDATE … WHERE last_alerted_threshold IS DISTINCT FROM $1 RETURNING`) and dispatch only when it returns a row.

**5.14 — Alert marked sent even when delivery failed** 🟡 [known H7]
`quotaMonitor.ts:58-69` ignores the result of `dispatchWebhook` and records the threshold anyway.

**5.15 — Alerts flap around 80%** 🟢
`quotaMonitor.ts:70-76`: with a sliding window, usage moves back and forth across 80%. Each dip resets the threshold to `null`, so the alert fires again.
**Fix:** add hysteresis (for example, reset only below 70%) or a cooldown.

**5.16 — Quota check is expensive** 🟡
`quotaMonitor.ts:26-30` runs `count(*)` over the whole window (1 hour) of the hypertable for every org with traffic, on every flush (up to every 500 ms).
**Fix:** read the count from the Redis sorted set (`ZCARD rate:org:<id>`), which is already exact.

**5.17 — Dropped and aborted requests are never logged** 🟡
Fastify runs `onResponse` only on the response's `finish`/`error` events (checked in `fastify/lib/reply.js:970-1010`). A chaos partition drop (`reply.hijack()` + `raw.destroy()`, `chaos/middleware.ts:81-82`) and a client abort never "finish", so these requests never reach `request_logs`. The dashboard shows 0% drops even with a 50% drop rate.
**Fix:** log the drop explicitly before destroying the socket, and listen for `close` as well.

**5.18 — Logs total is a full count every 5 s** 🟡 [known M2]
`service.ts:258-260`, called every 5 s by `analytics/page.tsx:58`.

**5.19 — UI: webhook create/delete fail silently** 🟢
`analytics/page.tsx:68-82` has no `onError`, so a 400 for an invalid URL shows nothing.

**5.20 — UI: offset pagination with live refresh** 🟢
`analytics/page.tsx:55-58`: new rows arrive every 5 s and push older rows onto the next page while the user is reading.

**5.21 — UI: status bar ignores 1xx/3xx** 🟢
`analytics/page.tsx:1076-1093` computes percentages from 2xx+4xx+429+5xx only, so a route that returns 301/304 disappears from the bar.

**5.22 — Inconsistent key display** 🟢
`service.ts:265` builds `${prefix}.${last4}`. Everywhere else uses `…`.

**5.23 — No minimum webhook secret length** 🟢
`routes/analytics.ts:120` accepts `secret: z.string().optional()`, so a one-character signing secret is allowed.

---

## Phase 6 — Chaos

**6.1 — `chaos_rules` table is never created** 🔴
`0006_chaos_rules.sql` is not journaled (same cause as 5.1). On any database built with `pnpm db:migrate`, including CI:

- Every `/api/chaos*` endpoint returns 500, and the Chaos Studio page shows nothing useful (see 6.9).
- `resolveChaosRule` throws on every mock request. The error is swallowed (`chaos/middleware.ts:64-67`) and never cached, so each mock call wastes a failing Postgres query and logs a warning.

CI did not catch this because the chaos tests mock the database entirely (see 6.13).

**6.2 — `statusCodes` accepts any integer** 🟡
`routes/chaos.ts:45` uses `z.array(z.number().int())`. A value like `0`, `99` or `700` makes `reply.code()` throw at request time, so the injected fault becomes a real 500. A value of `200` makes a "fault" that looks like success.
**Fix:** use `z.number().int().min(400).max(599)`.

**6.3 — Benchmark targets a service that doesn't exist** 🟡
`dashboard/chaos/page.tsx:102` sends `serviceSlug: 'flagship'`, but the flagship slug is `'ecommerce'` (`mock/seed.ts:14`). The server finds no service and silently falls back to the org default rule (`routes/chaos.ts:297-303`), so a service-scoped rule is never exercised.

**6.4 — The "live benchmark" is not live** 🟢
`routes/chaos.ts:319-351` only simulates dice rolls in-process. It never touches the real pipeline, the rate limiter, route latency or key-scoped rules. The `concurrency` option in the shared type (`shared/src/index.ts:395`) is ignored. The UI calls it a live benchmark that "Executes a batch of requests".

**6.5 — Error rates interact** 🟢
`chaos/sampling.ts:97-116` rolls for 429 first and only then for 5xx. The real 5xx rate is therefore `rate5xx × (1 − rate429)`: at 5% / 10%, you get 4.5% 5xx, not 5%. This breaks the Phase 6 exit criterion ("5% → ~5 failures per 100") whenever both rates are set.
**Fix:** draw one random number and compare it against cumulative bands.

**6.6 — Stale chaos rule for up to 60 s** 🟢
`chaos/cache.ts:144-160` has the same read-old / invalidate / write-old race as 3.12, but on Redis with a 60 s TTL, so other instances can keep using the old rule.

**6.7 — `KEYS` command** 🟡 [known M5]
`cache.ts:186`.

**6.8 — Handler still runs after the client aborts** 🟢
`chaos/middleware.ts:92-95` returns `undefined` when the socket is gone after the sleep. Fastify then continues to the handler, which renders the template and the route latency for a dead socket.
**Fix:** call `reply.hijack()` before returning.

**6.9 — UI: save and reset fail silently** 🟢
`chaos/page.tsx:66-96` has no `onError`. Combined with 6.1, "Publish Chaos Rules" just re-enables itself with no message.

**6.10 — Empty custom error message** 🟢
`chaos/page.tsx:41` starts with `customMessage: ''`. If the server rule never loads (see 6.1), saving stores `''`. The middleware uses `??` (`middleware.ts:109,117`), so the injected error is sent with an empty message.
**Fix:** use `||`, or strip empty strings with Zod.

**6.11 — UI covers only the org default** 🟢
The API supports per-service and per-key rules (`PUT /api/chaos`, `DELETE /api/chaos?serviceId=`), but the page only edits `defaultRule`. The latency slider stops at 2,000 ms (`chaos/page.tsx:302`) while the API allows 30,000. A rule set to more than 2 s through the API displays wrongly.

**6.12 — Rule precedence** 🟢
`cache.ts:85-89` lets a service rule win over a key rule. A per-key exemption therefore cannot override a service-wide rule. Document this, or reorder.

**6.13 — Tests mock everything** 🟡
`tests/chaos/*.test.ts` stub `resolveChaosRule` and the services module, and there is no Postgres-backed chaos route test. That is why 6.1 shipped with a green suite.

**6.14 — Uniform distribution ignores the mean** 🟢
`sampling.ts:60-63`: when `maxMs < 30000`, the range becomes `[minMs, maxMs]` and `meanMs` is ignored, while the UI still shows a mean slider.

---

## Phase 7–10 (not started) — issues already visible

**7.1 — Cross-site deploy will break auth** 🟡
The Phase 9 plan puts the web app on Vercel and the API on Fly/Railway, which are different sites. The cookies use `sameSite: 'lax'` (`routes/auth.ts:26,40`), so a cross-site `fetch` with `credentials: 'include'` does **not** send them.
The web origin also cannot read the API domain's CSRF cookie via `document.cookie` (`lib/api.ts:50-54`). Login would appear to work, and then every call would return 401 or 403.
**Fix:** serve both apps under one registrable domain (`app.x.com` and `api.x.com` with `COOKIE_DOMAIN=.x.com`), or proxy `/api` through Next.js.

**7.2 — No Dockerfile, no CORS lockdown, no dashboard limiter** 🟢
These are Phase 9 deliverables and do not exist yet. [known H8/M1]

**7.3 — Landing page shows the wrong key format and URL** 🟢
`web/src/app/page.tsx:287,291,367` shows `tb_live_…` and `/v1/mock/products`. The real format is `sk_live_<12>_<32>` and the real URL is `/mock/ecommerce/products`. Copy-pasting the example fails.

**7.4 — Hard-coded port in the error message** 🟢
`dashboard/layout.tsx:147-148` says "Verify the server is running on port 3001", whatever `NEXT_PUBLIC_API_URL` is.

---

## Already reported elsewhere (not repeated in detail)

From `SECURITY_AUDIT_2026_11_16.md`:

- H1: X-Forwarded-For hop counting
- H4: no session binding
- H6: latency analytics bypass the aggregate
- M4: chart buckets not zero-filled
- M6: `secretHash` stored in Redis
- M8: `touch` buffer is lossy
- M9: open registration
- M10: weak password policy
- M11: token length leak
- M12: error detail gated on `NODE_ENV`
- M14: no HSTS
- M15: no CSP

---

## Counts

| Phase        | 🔴    | 🟠     | 🟡     | 🟢     | Total   |
| ------------ | ----- | ------ | ------ | ------ | ------- |
| 0 Foundation | 0     | 2      | 2      | 6      | 10      |
| 1 Auth       | 0     | 3      | 2      | 11     | 16      |
| 2 Keys       | 0     | 0      | 5      | 8      | 13      |
| 3 Mock       | 0     | 2      | 6      | 17     | 25      |
| 4 Rate limit | 0     | 0      | 1      | 7      | 8       |
| 5 Analytics  | 2     | 3      | 7      | 11     | 23      |
| 6 Chaos      | 1     | 0      | 4      | 9      | 14      |
| 7–10         | 0     | 0      | 1      | 3      | 4       |
| **Total**    | **3** | **10** | **28** | **72** | **113** |

## Suggested order

1. **Database first.** Journal `0005` and `0006` properly (5.1, 6.1). Drop the FKs on `request_logs` (5.2). Fix `flushAll` (5.3) and the shutdown order (0.3).
2. **Lock-outs and DoS.** CSRF cookie expiry (1.1), absolute session expiry (1.2), logout cookie domain (1.3), Faker argument bounds (3.1), path normalization (3.2), header allowlist (3.3, 3.4).
3. **Get CI green.** `pnpm format`, `.gitattributes`, typed-route generation (0.1, 0.2). Add a Postgres-backed chaos route test (6.13).
4. **Correctness.** OpenAPI `{id}` and `security` (3.7, 3.8). The 429 flag (4.1). Partial aggregate data (5.7). Alert races (5.13). Chaos status-code validation (6.2). Benchmark slug (6.3).
5. **Performance.** Slug cache (3.11), negative key cache (2.4), quota count from Redis (5.16).
6. **UI and copy polish.** Everything 🟢 in the web app.
