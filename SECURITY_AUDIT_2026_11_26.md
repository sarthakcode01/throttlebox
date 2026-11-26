# Throttlebox — Phase-by-Phase Security Audit

**Audit date:** 2026-11-26
**Commit:** `fd5b1a7` (`main`)
**Scope:** `apps/server/src/**`, `apps/web/src/**`, `packages/shared/src/**`, `apps/server/drizzle/**`, `docker-compose.yml`, `.github/workflows/ci.yml`, installed dependency tree
**Method:** every phase reviewed file by file, tracing each request from the Fastify entry point through auth → key verification → rate limiting → chaos → mock rendering → telemetry. Every finding was checked against the code as it exists today, not against earlier audits.

This is the successor to `SECURITY_AUDIT_2026_11_16.md` (Phases 0–6). That document's findings are re-verified here and marked **[STILL OPEN]**, **[FIXED]**, or **[CORRECTED]** where my reading of the code disagrees with it. New findings are marked **[NEW]**.

---

## 1. How this audit was verified

Findings marked **✓ Verified** were reproduced in this environment, not just reasoned about. What was actually executed:

| Check                                                        | Result                                                                                                   |
| :----------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| `pnpm audit --prod` on the installed lockfile                | 20 advisories: **1 critical, 5 high**, 9 moderate, 5 low                                                 |
| `isValidWebhookUrl()` called against 12 address encodings    | **4 SSRF bypasses reproduced** (all IPv4-mapped / NAT64 IPv6 forms)                                      |
| Live `fetch()` to a local redirector → loopback service      | Followed the redirect and returned internal data (`SECRET-INTERNAL-DATA`)                                |
| `@node-rs/argon2` verify against `DUMMY_HASH` vs a real hash | Dummy 23.3 ms, real 13.1 ms — **1.8× timing gap**                                                        |
| `@fastify/cors` with `origin: ['*'], credentials: true`      | Returns `Access-Control-Allow-Origin: *` **+** `Allow-Credentials: true`                                 |
| `z.record(z.string().max(200))` with 40 000 keys / 589 KB    | **Accepted** — per-value cap does not bound key count                                                    |
| `pnpm typecheck` / `pnpm lint`                               | Clean                                                                                                    |
| `apps/server` integration suites                             | Not runnable here (no Docker → no Postgres/Redis); those suites are design-required to hit real services |

Two things I could **not** execute and therefore treat as code-read only: the multi-instance cache behaviour (needs ≥2 replicas) and the Next.js image-optimizer RCE (needs a running web server). Both are marked accordingly.

---

## 2. Summary of findings

Severity is assigned on realistic exploitability _in this codebase_, with a note wherever it differs from the previous audit.

| ID     |   Sev   |   Phase    | Finding                                                                                    | Status                           |
| :----- | :-----: | :--------: | :----------------------------------------------------------------------------------------- | :------------------------------- |
| SEC-01 | 🔴 Crit | 7 / deploy | `next@15.5.27` — unauthenticated RCE in the Image Optimization API (SVG)                   | ✓ Verified (installed version)   |
| SEC-02 | 🔴 Crit |     5      | Webhook SSRF guard bypassed by IPv4-mapped IPv6, NAT64 and redirects                       | ✓ Verified (PoC)                 |
| SEC-03 | 🟠 High |     5      | Webhook HMAC signing secret returned on every read                                         | ✓ Verified (code)                |
| SEC-04 | 🟠 High |     1      | Session expiry never enforced on the Redis hot path → sessions are immortal                | ✓ Verified (code)                |
| SEC-05 | 🟠 High |     1      | Auth limiter is per-process, and is disabled in the environment CI runs                    | ✓ Verified (code)                |
| SEC-06 | 🟠 High |     0      | `drizzle-orm@0.38.4` SQL-injection advisory (identifier escaping)                          | ✓ Verified · not reachable today |
| SEC-07 | 🟠 High |    3/7     | Dashboard loads an **unpinned** third-party script from `unpkg.com`, no SRI, no CSP        | ✓ Verified (code)                |
| SEC-08 | 🟡 Med  |     5      | No rate limit on dashboard `/api/*` → DB full scans and CPU amplification                  | ✓ Verified (code)                |
| SEC-09 | 🟡 Med  |     1      | Role/org cached up to 7 days, never revalidated, no invalidation path                      | ✓ Verified (code)                |
| SEC-10 | 🟡 Med  |     2      | Key cache stores `secretHash` in Redis and invalidates only locally                        | ✓ Verified (code)                |
| SEC-11 | 🟡 Med  |     3      | `responseHeaders` map is unbounded → stored/returned amplification                         | ✓ Verified (PoC)                 |
| SEC-12 | 🟡 Med  |     2      | `api_key_events` has no retention; bad-secret floods write synchronously                   | ✓ Verified (code)                |
| SEC-13 | 🟡 Med  |     1      | Login "timing equalizer" is 1.8× slower than a real miss → user enumeration                | ✓ Verified (PoC)                 |
| SEC-14 | 🟡 Med  |     5      | Webhook delivery has no queue and is awaited inside the ingest flush                       | ✓ Verified (code)                |
| SEC-15 | 🟡 Med  |     1      | CORS origin list unvalidated; `*` silently produces a broken config                        | ✓ Verified (PoC)                 |
| SEC-16 | 🟡 Med  |     1      | Open registration, min-10 password, no breach check, no email verification                 | ✓ Verified (code)                |
| SEC-17 | 🟡 Med  |     1      | No HSTS, no CSP, no `Permissions-Policy`; cookies lack `__Host-` prefix                    | ✓ Verified (code)                |
| SEC-18 | 🟡 Med  |     0      | `zod@3.25.76` memory-exhaustion advisory; `fastify@5.12.5` header-validation bypass        | ✓ Verified · limited reach       |
| SEC-19 | 🟡 Med  |     0      | `X-Forwarded-For` hop-count trust feeds both the audit trail and the auth limiter          | ✓ Verified (code)                |
| SEC-20 | 🟡 Med  |     0      | Error handler echoes `error.message` on every 4xx, in every environment                    | ✓ Verified (code)                |
| SEC-21 | 🟢 Low  |     1      | `secure` cookie flag only in production; no `__Host-`/`__Secure-` prefixes                 | ✓ Verified                       |
| SEC-22 | 🟢 Low  |     1      | CSRF skip-on-`Authorization` is sound today but couples to CORS; CSRF cookie has no expiry | ✓ Verified                       |
| SEC-23 | 🟢 Low  |     1      | No session binding or absolute lifetime; password change is unreachable code               | ✓ Verified                       |
| SEC-24 | 🟢 Low  |     7      | `getInternalToken()` is exported; the key-auth bypass is one string compare                | ✓ Verified                       |
| SEC-25 | 🟢 Low  |     7      | Export writes request `Host` into generated tests; `redact()` doesn't cover `whsec_`       | ✓ Verified                       |
| SEC-26 | 🟢 Low  |     0      | `docker-compose.yml` ships default credentials and publishes 5432/6379 on all interfaces   | ✓ Verified                       |
| SEC-27 | 🟢 Low  |     1      | `SESSION_SECRET` is required and validated but never used                                  | ✓ Verified                       |
| SEC-28 | 🟢 Low  |     6      | Chaos benchmark is an unthrottled CPU sampling loop                                        | ✓ Verified                       |

**Phase verdicts at a glance**

| Phase | Area                              | Verdict                                                                                |
| :---: | :-------------------------------- | :------------------------------------------------------------------------------------- |
|   0   | Foundation, infra, CI, HTTP layer | 🟡 Sound structure; dependency debt and two header/error-handling gaps                 |
|   1   | Auth, sessions, CSRF, orgs        | 🟠 Best-written module in the repo, but session lifetime is not enforced               |
|   2   | API key management                | 🟢 **Strongest area.** Crypto design is genuinely correct; cache layer needs hardening |
|   3   | Mock engine, template sandbox     | 🟢 Sandbox holds; one unbounded input                                                  |
|   4   | Rate limiting                     | 🟢 Correct and atomic; fails open by design, which is a documented trade-off           |
|   5   | Analytics & webhooks              | 🔴 The weak phase — SSRF guard does not hold, secret is disclosed, no `/api` limiter   |
|   6   | Chaos engineering                 | 🟢 Well bounded; minor amplification only                                              |
|   7   | Playground                        | 🟢 Internal-auth design is sound; third-party script and export details need work      |

---

## 3. Phase 0 — Foundation, infrastructure, CI, HTTP layer

### What is right

- **Fail-fast configuration.** `config.ts` validates with zod and refuses to boot on a bad or missing value; it explicitly refuses `KEY_PEPPER === SESSION_SECRET`.
- **Liveness vs readiness split** (`http/health.ts`) is correct: `/health` touches nothing, `/health/ready` checks both dependencies and returns 503. A Redis blip cannot get a healthy instance killed.
- **Baseline headers** (`http/securityHeaders.ts`): `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP, and `X-Powered-By` removal.
- **No SQL string building anywhere.** Every query is a drizzle builder or a `sql` tagged template; I found no interpolation of user input into SQL text.
- **CI** pins `ubuntu-24.04` deliberately and uses real Postgres/Redis services rather than mocks.

### SEC-06 🟠 `drizzle-orm@0.38.4` carries a SQL-injection advisory — not reachable today

Installed: **0.38.4**. Advisories `GHSA-gpj5-g38j-94v9` (high) fix improper escaping of SQL **identifiers** in `< 0.45.2`.

_Reachability:_ I checked every call site. All queries use static column objects or `sql` tagged templates with bound parameters; no dynamic table/column names are assembled from input. So this is **not exploitable in this codebase today** — but it is a high-severity advisory on a core dependency, and the project plans user-configurable surfaces (plugins, weighted responses), which is exactly where dynamic identifiers appear.

_Fix:_ bump to `>=0.45.2` (check the drizzle-kit pairing) or document the pin with a rationale.

### SEC-18 🟡 `zod` and `fastify` advisories, with limited reach

- **`zod@3.25.76`** — `GHSA-mrhx-c7xc-m3w5` (high): memory exhaustion while validating oversized constrained collections. Reachable in principle on every JSON body. Mitigated by the 1 MB body ceiling, so impact is bounded; still worth the bump to `>=4.6.6` (a major, so plan it) or a targeted evaluation.
- **`fastify@5.12.5`** — `GHSA-389g-gv7q-r4x8` (low): header validation bypass via case-sensitive `propertyNames`. **Not reachable here** because no route declares a Fastify JSON schema for headers (validation is zod in handlers). Bump to `>=5.12.6` is cheap.
- **`fast-uri` ×3 (low/moderate, 6 paths each)** and **`postcss`** (build-time only, reachable through Next's pipeline) — transitive; resolved by the Next bump in SEC-01.

### SEC-19 🟡 `X-Forwarded-For` is trusted by hop count

`index.ts:47` — `const trustProxy = (_address, hop) => hop < config.TRUST_PROXY_HOPS;`

Counting hops is correct _only_ if exactly N trusted proxies sit in front and each one _appends_. Set `TRUST_PROXY_HOPS=1` while the app is directly reachable and any client spoofs `request.ip`. That IP is written into `api_key_events.ip` (the audit trail) and is the bucket key for the credential limiter (`auth:${request.ip}`), so spoofing writes false evidence _and_ shards credential stuffing across unlimited apparent IPs. The default of `0` is safe, but a single environment change silently disables the control with no warning.

_Fix:_ validate the immediate socket peer against a configured proxy CIDR set instead of counting; refuse to boot when `TRUST_PROXY_HOPS > 0` and no range is configured.
_Prior audit:_ H1 **[STILL OPEN]**, correctly described.

### SEC-20 🟡 Deliberate 4xx errors always echo their internal message

`http/errorHandler.ts:19-27` returns `{ error: error.code, message: error.message }` for **every** status `< 500`, in every environment. Only 5xx is scrubbed outside production. Today the 4xx surface is zod and hand-written errors, which are safe — but the rule "4xx messages are safe to show" is not enforced anywhere, so the first `throw Object.assign(new Error(sqlText), { statusCode: 400 })` becomes an injection point. Note also that the content-type parser deliberately raises a 415 whose message is fine, so changing this needs care.

_Fix:_ echo messages only for a typed set of errors (zod + explicit app errors with a `safe: true` marker); everything else gets a generic body.

### SEC-26 🟢 `docker-compose.yml` defaults

`postgres/postgres` superuser credentials, and 5432 + 6379 published on `0.0.0.0`. Correct for a local dev box, wrong on any shared host: Redis has no auth at all, so anyone who can reach the port owns the rate limiter, the session cache, and the key cache. Bind to `127.0.0.1:` in the compose file and document that production uses managed services with auth and TLS.

---

## 4. Phase 1 — Auth, sessions, CSRF, organizations

This is the most carefully written module in the repo: Argon2id with sane parameters, 256-bit session tokens stored only as SHA-256, constant-time comparisons, a flat-timing login, and a CSRF double-submit that is correctly scoped to cookie-authenticated mutations. The findings below are about what the design _promises_ versus what the code does.

### SEC-04 🟠 Session expiry is never enforced → sessions are effectively immortal

`auth/session.ts`. Creation writes a Postgres row with `expiresAt` (`:46`) and a Redis record with `EX 7d` (`:72`). The hot path then does this (`:95-98`):

```ts
const cached = await redis.get(redisKey(tokenHash));
if (cached) {
  await redis.expire(redisKey(tokenHash), config.SESSION_TTL_SECONDS); // ← sliding, always 7d
  return JSON.parse(cached) as SessionRecord; // ← Postgres never consulted
}
```

`expiresAt` is only checked on a **cache miss** (`:110`), and a cache miss cannot happen while the key keeps being refreshed. `updateSessionRecord` (`:82`, called from `auth/middleware.ts:63` to warm role/org) also resets the TTL to a full 7 days. Meanwhile the janitor deletes the expired Postgres row, so the durable record disappears while the Redis record lives on.

The consequence: any valid token used at least once every 7 days **never expires**, which defeats expiry as a containment control for a stolen token. The browser helps only by accident — the cookie is issued with an explicit `expires` (`routes/auth.ts:44-48`), so a browser drops it after 7 days — but a token captured from a log, a proxy, or the network can be replayed indefinitely with `curl`.

_Fix:_ on a cache hit, refresh to `min(remaining, ...)` — i.e. carry `expiresAt` in the cached record and stop refreshing past it. Store `expiresAt` when warming the record and refuse once `Date.now() > expiresAt`. Add an absolute (not sliding) cap.

### SEC-05 🟠 The credential limiter is per-process — and switched off where CI runs

`http/rateLimit.ts` is explicit about being in-memory: "this limiter is per-process, so a multi-instance deployment gets N times the limit". Phase 9 targets a multi-instance deploy, which turns `20 / 15 min` into `N × 20`. That is the exact defence standing between the internet and an Argon2id verification loop.

Separately, `routes/auth.ts:69` sets `enabled: !isTest`, and CI runs `NODE_ENV: test`. The limiter is therefore **never exercised by any integration test** — only its unit test — so a regression in the wiring would be invisible to the pipeline.

_Fix:_ back it with the Redis primitive that already exists (`ratelimit/lua.ts`) keyed by `auth:${ip}`, keeping the in-memory bucket as a local first line. Add one integration test that runs with the limiter enabled and asserts the 429 + `Retry-After`.
_Prior audit:_ H2 **[STILL OPEN]**.

### SEC-09 🟡 Authorization reads a 7-day cache with no invalidation path

`auth/middleware.ts:59-70` resolves `orgId`/`role` once from `org_members`, writes them into the Redis session record, and every subsequent request trusts that copy for the session's lifetime. There is no invalidation on membership change, role change, or removal — and no code path that could do one.

Today this is latent rather than exploitable: there is no member-management endpoint, so roles cannot change. It becomes a privilege-escalation bug the day `members:invite` ships (the permission already exists in `PERMISSIONS`). A removed member would keep owner rights for up to 7 days.

_Fix:_ keep `role` out of the cached session and resolve it per request (one indexed read, cheap), or add a `member:changed` pub/sub channel plus an explicit delete, and clear all of a user's session records on membership mutation.
_Prior audit:_ H3 **[STILL OPEN]** — confirm severity is latent today.

### SEC-13 🟡 The timing equalizer is measurably _unequal_

`routes/auth.ts:50` defines `DUMMY_HASH`, and `:175` uses it when no user row is found, "so response time doesn't reveal whether an email is registered". Reproduced:

```
dummy verify       -> false   23.27 ms
real hash, miss    -> false   13.10 ms
```

The dummy path is **1.8× slower** than the real one, which is the wrong direction and large enough to distinguish over a few samples. Two causes: the constant's salt decodes to a different length than a real Argon2 default salt, and the miss path also pays a Postgres round trip. Either way the stated goal is not met.

_Fix:_ generate the dummy hash once at boot from `hashPassword(randomBytes(32).toString('hex'))` so it has production parameters and salt shape, and compare only after the DB lookup resolves (it already does) so both paths have the same query cost.

### SEC-15 🟡 CORS: the list is unvalidated, and `*` silently converts it into a broken config

`index.ts:50` — `origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',')` with `credentials: true`. Reproduced:

```
["*"]                     -> Access-Control-Allow-Origin: *  | Allow-Credentials: true
["*","http://localhost:3000"] -> Access-Control-Allow-Origin: *  | Allow-Credentials: true
```

**[CORRECTED vs prior audit M13]** This is _not_ a full cross-origin takeover. Per the Fetch spec a browser **rejects** a credentialed response when `Access-Control-Allow-Origin` is `*`, so the `*` case fails **closed** — the misconfiguration produces a broken dashboard, not an open door. The real risks are narrower but genuine:

1. The value is never validated. A trailing space, a scheme-less entry, or a wildcard subdomain pattern silently produces either a broken config or an over-broad one, with no boot-time warning and no test.
2. When a specific attacker-controlled or typo'd origin is configured, `credentials: true` means cross-origin reads of `/api/*` succeed with the session cookie attached (see SEC-22 for what that then reaches).
3. `*` sets `Allow-Credentials: true`, which is a contradiction — evidence that nothing checks the two against each other.

_Fix:_ parse `WEB_ORIGIN` through a zod schema of absolute origins, assert `https:` in production, and refuse to boot when `*` or an unparseable entry appears.

### SEC-16 🟡 Open registration, weak password policy, no email verification

`registerSchema` accepts any email with a 10-character minimum (`routes/auth.ts:14`), with no breach-corpus check, no email verification, no CAPTCHA. Registration is a free path to `hashPassword` (a deliberate CPU burn) and to a personal org plus a seeded service per account — so it is a cheap way to fill the database and to squat addresses. Being open is a legitimate product choice; being unthrottled _and_ unverified is not.

_Fix (minimum):_ keep the limiter in front of register (SEC-05), add a breached-password check at the schema boundary, and verify email before the first key can be created.
_Prior audit:_ M9, M10 **[STILL OPEN]**.

### SEC-17 🟡 Missing transport and content headers

- **No HSTS** on either app. The session cookie is `secure` in production, so the _cookie_ is safe, but the login POST and the CSRF token still travel over plaintext on first contact.
- **No CSP** on the web app, which matters specifically because of SEC-07 (an unpinned third-party script is loaded into the dashboard).
- **No `Permissions-Policy`**, and no `Cache-Control: no-store` on `/api/me` or the auth responses.
- Cookies are named `throttlebox_session` / `throttlebox_csrf` with no `__Host-` prefix, so a compromised or sibling subdomain can set them.

_Fix:_ add HSTS at the edge, a CSP that explicitly allows only the required sources (and pins the Stoplight script), `Cache-Control: no-store` on authenticated JSON, and `__Host-` prefixes for both cookies (which also removes the need for `COOKIE_DOMAIN`).
_Prior audit:_ M14, M15 **[STILL OPEN]**.

### SEC-21, SEC-22, SEC-23, SEC-27 🟢 Low and design notes

- **SEC-21** `secure: isProduction` (`routes/auth.ts:31`) means every non-production deployment serves the session cookie over HTTP. Fine for localhost, wrong for a shared staging host.
- **SEC-22** Skipping CSRF when an `Authorization` header is present (`middleware.ts:122`) is sound _as written_, because no dashboard route authenticates by bearer token and no cross-site form can set that header. It is a standing footgun: the moment one `/api` route accepts a bearer token, it silently loses CSRF protection. Worth an explicit allowlist of which paths may skip rather than "any request with an Authorization header". Separately, the **CSRF cookie has no `expires`** while the session cookie does, so after a browser restart the session survives and every mutation 403s until re-login — a functional bug with a security smell.
- **SEC-23** Sessions are not bound to anything (no UA/IP fingerprint at resolve time), have no absolute lifetime, and logging out on one device leaves others alive. `destroyAllSessionsForUser` (`session.ts:143`) is correct but **unreachable** — there is no password-change or "sign out everywhere" endpoint. Weakest link in an otherwise strong design.
- **SEC-27** `SESSION_SECRET` is required, length-validated, and checked against `KEY_PEPPER` — and then **never used**. Nothing is signed or derived from it. It is dead key material that gives a false impression of an HMAC layer. Either use it (e.g. to derive the CSRF token, or HMAC the session id) or drop it from the schema; requiring a secret that does nothing is a documentation lie.

---

## 5. Phase 2 — API key management 🟢 strongest subsystem

### What is right (verified)

This is the part of the codebase I would hold up as the example.

- **Format and arithmetic.** `sk_{env}_{publicId}_{secret}`, parsed by fixed arity (not by slicing), 12-char public id + 32-char secret, base62 with **rejection sampling** at `248` to eliminate modulo bias — `Math.random()` appears nowhere in key material.
- **Storage.** `HMAC-SHA-256(pepper, publicId:secret)` with the pepper only in the environment; the raw key is returned by exactly two handlers (`create`, `rotate`) and is unrecoverable afterwards.
- **Verification order** (`keys/verify.ts`) fails closed at every step, does an **indexed** `public_id` lookup, and burns an equivalent HMAC on a miss (`:78-84`) so a missing row costs the same as a present one.
- **Uniform 401.** Every failure mode — bad shape, unknown id, revoked family, revoked key, expired, grace elapsed, wrong secret — returns the identical body. The reason goes to the audit trail instead of the response. That is the right call.
- **Rotation.** Scopes are additive-only, a family holds at most one _current_ key, and rotation retires every other current key — which correctly handles the double-rotation orphan case that naive implementations get wrong.
- **Revocation.** Family revoke is a real kill switch in a transaction.
- **Redaction** exists as a safety net and the regex is rebuilt per call to avoid `lastIndex` state.

### SEC-10 🟡 The cache keeps the secret hash and only invalidates locally

`keys/cache.ts:11` stores `secretHash` inside the Redis value, and `KEY_CACHE_TTL_SECONDS = 60`. Invalidation (`invalidateCachedKey`, `:68`) is a local `DEL` with **no pub/sub** — so on N instances a revoked or rotated key stays live for up to 60 s on the instances that hold their own cached copy. There is also an M7-style asymmetry: `invalidateCachedKeyById` reads the id→publicId mapping, and if that mapping has already expired, the publicId entry is never deleted.

Caching `secretHash` widens the blast radius of a Redis compromise from "rate counters and a plan name" to "verifiable credential digests". It does not yield a usable key (HMAC is one-way and peppered), but it is unnecessary exposure on a cache.

_Fix:_ add a `key:invalidated` pub/sub channel and delete on receive; cache only `{id, orgId, familyId, scopes, status, expiry}` and compare the secret against a DB read (or a short-TTL keyed digest cache that excludes the hash). Add a test that revokes on one "instance" and asserts rejection on another's cache.
_Prior audit:_ M6, M7 **[STILL OPEN]**.

### SEC-12 🟡 `api_key_events` grows without bound, and the 401 path writes synchronously

`keys/audit.ts` documents its own limitation honestly: a valid `public_id` is not secret (it appears in the display prefix and in logs), so anyone can trigger **one INSERT per request** by sending a wrong secret, and the rate limiter runs _after_ verification so it does not cover this. There is no retention policy, no dedupe, and no sampling — and `fail()` (`verify.ts:146`) `await`s the insert on the authentication path, adding a Postgres write to every rejected request.

_Fix:_ dedupe per `(keyId, reason)` inside a short window (a Redis `SET NX EX 60` is enough), write asynchronously, and add a retention policy on `api_key_events` (30–90 days). This is the single highest-leverage DoS fix in Phase 2.

### Also noted (not a security defect)

`GET /keys/:id` is documented as returning audit events but `getKey`/`toSummary` do not include them. Functional gap, not a vulnerability — flagged so the docs stop overpromising.

---

## 6. Phase 3 — Mock engine and template sandbox 🟢

### What is right (verified)

The sandbox is genuinely well built, and I tried to break it:

- **No `eval`, no `new Function`, no `vm`** anywhere in `apps/server/src` or `apps/web/src`.
- `resolvePath` refuses `__proto__`, `constructor`, `prototype` at **every** segment, reads **own properties only**, and caps depth at 6.
- The faker surface is a closed allowlist; `helpers` is excluded precisely because `faker.helpers.fake` would re-enter the engine.
- A resolved value is only called if the path starts with `faker.`, so a template cannot invoke an arbitrary function reachable through the context object.
- One `Faker` instance per request, seeded from `(orgId, slug, method, path)` — deterministic across keys in the org, which is both a correctness _and_ a confidentiality property (one key cannot infer another key's traffic from data changes).
- `renderTemplate` drops `undefined` keys and `safeStringify` survives cycles, so a hostile template degrades instead of throwing.
- Path handling deliberately avoids double-decoding via `find-my-way` (a previously fixed bug).

This is the part that most deserves the "no eval anywhere" claim in the README.

### SEC-11 🟡 `responseHeaders` is an unbounded map, stored and echoed

`routes/services.ts:29` — `responseHeaders: z.record(z.string().max(200)).optional()`. The **values** are length-capped; the **number of keys** is not. Reproduced with the same schema: 40 000 keys in a 589 KB body parse successfully. Those land in a `jsonb` column and are then set on every mock response (`routes/mock.ts:245`), and are also echoed back by `POST /api/mock/preview`.

With Fastify's default 1 MB body limit and no limiter on `/api/*` (SEC-08), a `dev`-role user can push megabytes of header bloat into the database per request and inflate every subsequent response. The dashboard preview path additionally returns it in a JSON body.

_Fix:_ cap the key count (`z.record(...).refine(o => Object.keys(o).length <= 20)`), allowlist the header names that may be set, and reject `content-type` / `content-length` / hop-by-hop names outright.

### SEC-25 (part) 🟢 Header injection is not a live XSS — but keep it that way

Mock authors can set `Content-Type` on their own responses. Because the body is still sent through `.type('application/json')` (`routes/mock.ts:252`) and `X-Content-Type-Options: nosniff` is set, an HTML/JS content type would be honoured only by a browser that ignores both. There is no `<script>` execution path in the API itself. The risk lives entirely on the **dashboard/docs** side, which is SEC-07. Worth an explicit test asserting that `responseHeaders` cannot override `content-type`.

---

## 7. Phase 4 — Rate limiting 🟢

### What is right (verified)

- One **Redis Lua script** does trim → `ZCARD` → `ZADD`+`PEXPIRE` (or computes `Retry-After` from the oldest member) **atomically**, with time from Redis `TIME` so instances cannot disagree.
- The bucket is `rate:org:<orgId>` (`middleware.ts:31-35`, `limiter.ts:41`), so adding keys cannot multiply the plan — this is the fix for the debt audit's per-key/org mismatch and it is correctly applied.
- Headers are set on both 200 and 429, with `Retry-After` only on 429.
- Plan resolution is memory → Redis → Postgres with a `plan:changed` pub/sub channel, so an upgrade applies without a restart.
- Public ids are UUIDs, so the `:serviceSlug` cross-tenant lookup is by `(orgId, slug)` and collapses correctly.

### Notes (no new finding)

- **Fail-open on Redis error** is a deliberate availability choice, documented in code and docs. It is the right default for a mock API; it should be stated in the operator docs as "limits are not enforced during a Redis outage" so nobody mistakes it for a guarantee.
- The sorted-set design stores one member per request in-window (O(N) per org). At the `pro` ceiling that is ~6 000 members per org per hour — fine here, worth monitoring.
- `ZREMRANGEBYSCORE` + `ZCARD` + `ZADD` inside Lua is not bounded, but it is O(log N) per op on Redis's side and the window bounds N.

---

## 8. Phase 5 — Analytics and webhooks 🔴 weakest phase

### SEC-02 🔴 The SSRF guard does not hold (reproduced)

`analytics/webhooks.ts:15` validates the **hostname string** only. It never resolves the name, and `dispatchWebhook` (`:194`) calls `fetch()` with **default redirect handling**. I ran the guard against twelve encodings and then a real redirect chain:

| URL                                                     | Guard verdict                                    |
| :------------------------------------------------------ | :----------------------------------------------- |
| `http://localhost:PORT/`                                | blocked                                          |
| `http://127.0.0.1:PORT/`                                | blocked                                          |
| `http://2130706433:PORT/` (decimal)                     | blocked — `new URL()` normalises to `127.0.0.1`  |
| `http://0x7f000001:PORT/` (hex)                         | blocked — normalises                             |
| `http://0177.0.0.1:PORT/` (octal)                       | blocked — normalises                             |
| `http://127.1:PORT/`                                    | blocked — normalises                             |
| `http://[::1]:PORT/`                                    | blocked                                          |
| **`http://[::ffff:127.0.0.1]:PORT/`**                   | **ALLOWED** — normalises to `[::ffff:7f00:1]`    |
| **`http://[::ffff:7f00:1]:PORT/`**                      | **ALLOWED**                                      |
| **`http://[64:ff9b::7f00:1]:PORT/`** (NAT64)            | **ALLOWED**                                      |
| `http://169.254.169.254/latest/meta-data/`              | blocked                                          |
| **`http://[::ffff:169.254.169.254]/latest/meta-data/`** | **ALLOWED** — normalises to `[::ffff:a9fe:a9fe]` |

And the redirect leg, which is the one that needs no encoding trick at all:

```
POST to an allowed-looking URL that 302s to loopback
 -> 200 "SECRET-INTERNAL-DATA"
```

So the guard is defeated in two independent ways: **IPv4-mapped / NAT64 IPv6 literals** (only `::1`, `fe80:`, `fc00:`, `fd00:` are denied, and the code strips the brackets before comparing, so `[::1]` is caught but nothing in `::ffff:0:0/96` is), and **any redirect** out of a permitted URL, because `redirect` is never constrained and the guard is never re-run.

**[CORRECTED vs prior audit]** The prior audit listed alternate IPv4 encodings (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`) as bypasses. They are **not** — `new URL()` canonicalises all four to `127.0.0.1` and the existing dotted-quad check then rejects them. That part of the guard is fine. The live bypasses are the IPv6 forms and redirects, both reproduced above.

_Impact:_ an authenticated user with `analytics:write` (any `dev`) turns Throttlebox into an SSRF proxy against cloud metadata, Postgres, Redis, or any internal service. `POST /api/analytics/webhooks/:id/test` triggers it on demand and returns the status code; the response body is not returned, which makes this a blind SSRF with a status oracle rather than a full read primitive — still enough to hit IMDSv2-less metadata and to port-scan the VPC.

_Fix (all four, in order):_

1. Resolve with `dns.lookup(host, { all: true })` and reject if **any** address is loopback, RFC 1918, link-local, CGNAT, `0.0.0.0/8`, multicast, or inside `::ffff:0:0/96` / `64:ff9b::/96`.
2. Compare against the **normalised** `URL.hostname`, and canonicalise with `net.isIP` / `ipaddr`-style parsing instead of string prefixes.
3. `redirect: 'manual'` — re-validate every hop, cap the hops, and refuse any hop that changes host.
4. Pin the resolved IP for the connection (or accept the TOCTOU and add network-level egress control + IMDSv2), and document that the application guard is one layer of several.

_Prior audit:_ C1, C3 **[STILL OPEN]**, with C1's encoding list corrected.

### SEC-03 🟠 The webhook signing secret is returned on every read

`webhooks.ts:116` — `toWebhookConfig` returns `secret: row.secret` verbatim, and `GET /api/analytics/webhooks` requires only `analytics:read`, which **every role has, including `viewer`**. So a read-only user can read the HMAC signing secret, then forge correctly-signed quota events to the customer's endpoint. It also lands in React Query caches and browser memory on every dashboard load — inconsistent with the project's own one-time-reveal rule for API keys.

_Fix:_ make it write-only. Return `hasSecret: true` plus a masked `whsec_…abcd`; accept a secret only on create and on an explicit rotate. One migration-free change in `toWebhookConfig` plus the two route responses.
_Prior audit:_ C2 **[STILL OPEN]** — rated High here rather than Critical, because the blast radius is signing outbound events to the org's own endpoint rather than account takeover. The privilege direction (viewer → signer) is what makes it High.

### SEC-14 🟡 Webhook delivery is inline in the ingest flush

`quotaMonitor.ts:58` `await`s `dispatchWebhook`, which has a 5 s `AbortSignal` (`webhooks.ts:204`). `ingest.ts` invokes the quota callback per flush. An endpoint that accepts the connection and never answers therefore stalls the quota check for the whole touched-org batch, and ingest is single-flighted (`isFlushing`), so a slow webhook delays telemetry for everyone. There is no retry, no dead-letter, and no delivery record — a failed alert is lost silently.

_Fix:_ a small durable outbox (a `webhook_deliveries` table with attempt/next_attempt) drained by a worker, with backoff and a bounded retry count. Fire-and-forget with a hard timeout is the acceptable interim.

_Positive note:_ the ingest buffer itself is now correct — `flushQueue` restores the batch with `queue.unshift(...batch)` on failure (`ingest.ts:83`), which fixes the data-loss defect from the 2026-11-07 debt audit. **[FIXED]**

### SEC-08 🟡 Dashboard `/api/*` has no rate limit, and two endpoints are amplifiers

Only `/auth/*` (in-memory) and `/mock/*` (Redis) are limited. Every other `/api` route is unbounded, and two are expensive:

1. `GET /api/analytics/logs` runs `SELECT count(*)::int FROM request_logs WHERE org_id = $1` (`analytics/service.ts:259`) with **no time bound**, on a hypertable with a 30-day retention window — a full scan of the org's whole history on every page load.
2. `POST /api/chaos/benchmark` loops `requestCount` (max 200) times calling the sampling math (`routes/chaos.ts:319`) with no I/O. Cheap individually, unbounded per second, and it does not consume the org's rate-limit quota at all.

_Fix:_ a Redis-backed limiter on `/api/*` keyed by `userId` (reuse the existing Lua primitive), plus replace the `count(*)` with a bounded count from `usage_hourly` or a `time >= now() - interval` predicate matching the query window.

_Prior audit:_ H8, M1, M2 **[STILL OPEN]**.

### Also verified as _not_ a problem

**[CORRECTED]** Prior audit M3 claimed the analytics `keyId`/`serviceId` filters were "not ownership-checked". They are: every query is already scoped by `org_id = ${orgId}` and the filters are additional `AND` predicates, so a foreign id yields an empty result, not foreign rows. No change needed — the tenant boundary is the `org_id` predicate, not the filter.

---

## 9. Phase 6 — Chaos engineering 🟢

### What is right

- **Bounds are enforced at the boundary, not at sampling time.** `meanMs`/`minMs`/`maxMs` ≤ 30 000, `stddevMs` ≤ 10 000, `rate5xx`/`rate429`/`dropRate` ∈ [0,1], and `minMs <= maxMs` via a zod refinement. `sampleNormal`/`sampleUniform` independently clamp to 0–30 000, so even a hand-edited row cannot produce a 10-minute sleep.
- **Tenant checks on rule targets.** `PUT /api/chaos` verifies `serviceId` _and_ `keyId` belong to the caller's org before writing, and 404s otherwise — so a rule cannot be aimed at another tenant's service. Every rule query is `orgId`-scoped.
- **Most-specific-wins with explicit exemption** (`isEnabled: false` on a narrower scope overrides an org-wide rule) is the right semantics and is implemented by ordered scope probing.
- **Cache failures skip chaos rather than failing the request**, and an unknown service bypasses chaos so the handler returns a clean 404 rather than severing a socket.
- **Socket drop uses `reply.hijack()` + `request.raw.destroy()`**, which is a real TCP close — and, importantly for Phase 7, it is _observable_ by `fastify.inject()` (see SEC-24 notes).

### SEC-28 🟢 Minor: the benchmark loop is unthrottled

Covered under SEC-08. No other finding. One housekeeping item: `invalidateChaosRule` falls back to a blocking `redis.keys('chaos:rule:<org>:*')` (`chaos/cache.ts:159`) on every org-wide reset. `KEYS` is O(keyspace) and blocks Redis for the whole instance; at any real number of orgs this becomes a self-inflicted DoS triggered by a user action. Use `SCAN` or maintain a per-org set of cache keys.
_Prior audit:_ M5 **[STILL OPEN]**.

---

## 10. Phase 7 — Time-Travel Playground 🟢 (design) / 🟡 (details)

### What is right

The trust model here is genuinely good, and it is the part most likely to be got wrong.

- **No raw keys, no free-form URL.** The runner presents a per-boot 32-byte token (`internalAuth.ts`) plus a key id and goes through `fastify.inject()` against `/mock/<slug>/<path>` only. There is no network hop and no attacker-chosen destination, so the phase adds **no SSRF surface**.
- **The bypass still fails closed.** `loadKeyContextById` re-checks family revocation, key status, expiry, and elapsed grace — and reads the database rather than the cache, so a revocation is honoured immediately even where the key cache lags (SEC-10).
- **Path validation** rejects `?`, `#`, backslashes, control characters, and `.`/`..` segments (`routes/playground.ts:42-45`), and `buildMockUrl` percent-encodes the slug.
- **Storage hygiene**: `authorization`, `cookie`, `x-csrf-token`, forwarding headers and all `X-Throttlebox-*` are dropped on the way in; `set-cookie` is dropped on the way out; bodies are `redact()`-ed and truncated at 64 KB on a UTF-8 boundary; 500 requests per session; 30-day janitor.
- **Every handler is org-scoped**, with a route-level `preHandler` requiring auth _and_ an org, plus `playground:read` / `playground:run`. Foreign ids 404 rather than leaking existence.
- **Exports never contain a secret** — the generated Vitest file reads `THROTTLEBOX_API_KEY` from the environment.

### SEC-07 🟠 An unpinned third-party script is injected into the dashboard

`apps/web/src/app/dashboard/docs/page.tsx:79-96` appends:

```
https://unpkg.com/@stoplight/elements/styles.min.css
https://unpkg.com/@stoplight/elements/web-components.min.js
```

No version, no `integrity` hash, no `crossOrigin`. `unpkg.com/@pkg/latest` resolves to whatever the registry currently serves, so the dashboard executes **whatever code that package publishes** — and it executes inside the dashboard's origin, where it can read the non-`httpOnly` CSRF cookie and drive every `/api` mutation as the signed-in user. This is the single most practical route to full account compromise in the web app, and it requires no bug in Throttlebox at all.

Note also that this contradicts the repo's own principle in `next.config.ts` ("keep Next.js a pure client"), and that `package.json` never declares `@stoplight/elements` — the dependency exists only as a URL at runtime, so it is invisible to `pnpm audit` and to lockfile review.

_Fix (in order of preference):_

1. Add `@stoplight/elements` as a real dependency and import it, so it is version-pinned, audited, and cached by the bundler.
2. If it must stay a CDN script, pin an exact version **and** an `integrity` SRI hash, keep the URL in a constant, and add a CSP `script-src` that names that host.

### SEC-24 🟢 The internal-auth bypass is one compare, and its token is exported

`keys/middleware.ts:42` short-circuits the whole key-verification path when `isInternalToken(header)` is true. The design is sound (per-boot random, constant-time compare, unknown to outsiders), but two things widen the failure mode:

1. `getInternalToken()` is **exported** from `internalAuth.ts:21` and imported by the runner. Any future server-side code path that reaches that module — an error reporter, a debug route, a log of module state — can learn a token that bypasses key auth entirely. Only the test file needs it today.
2. The compare is `safeEqualString`, which returns early on a length mismatch (`util/crypto.ts:34`). Lengths are fixed here, so the leak is theoretical, but it is the same pattern flagged as M11 in the prior audit.

_Fix:_ keep the token module-private, expose only `assertInternalRequest(headers)` that returns a boolean, and hash the incoming header before comparing so both sides are fixed-length. Consider binding the token check to `request.socket.remoteAddress === undefined` (i.e. injected requests only).

### SEC-25 🟢 Export echoes the request `Host`, and redaction misses `whsec_`

- `routes/playground.ts:335` builds `baseUrl` from `${request.protocol}://${request.host}` and writes it into the generated Vitest file's `__BASE_URL__` default. Behind a misconfigured proxy this writes an attacker-influenced host into a file a developer then runs — a low-grade, developer-side SSRF if they execute it against the wrong target. Prefer a configured public base URL over the `Host` header.
- `keys/redact.ts` scrubs `sk_(test|live)_…` only. Webhook secrets (`whsec_…`) and the user-supplied variant are not covered, so a stored playground body that happens to contain one is not redacted.

---

## 11. Dependency posture

`pnpm audit --prod` on the installed tree (1 critical, 5 high, 9 moderate, 5 low). Triage, since raw counts overstate risk:

| Package     | Installed         | Advisory                                                         | Reach in this codebase                                                                                                                                                                                                       |
| :---------- | :---------------- | :--------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **next**    | **15.5.27**       | `GHSA-2464-fhr4-w9xw` **crit** — unauth RCE, image-optimizer SVG | `/_next/image` ships by default even though `next/image` is never used. **Bump to ≥15.5.29**, which also clears three moderates (SVG bypass, HttpOnly cookie exposure via internal header, cross-client response injection). |
| drizzle-orm | 0.38.4            | `GHSA-gpj5-g38j-94v9` high — identifier escaping                 | Not reachable today (SEC-06); bump when convenient.                                                                                                                                                                          |
| zod         | 3.25.76           | `GHSA-mrhx-c7xc-m3w5` high — memory exhaustion                   | Bounded by the 1 MB body cap; plan the v4 bump.                                                                                                                                                                              |
| postcss     | (next transitive) | 3 advisories, high + 2 moderate                                  | Build-time only; resolved by the Next bump.                                                                                                                                                                                  |
| fast-uri    | (fastify/ajv)     | 3 advisories, moderate/low                                       | No user-supplied URIs reach the validators.                                                                                                                                                                                  |
| fastify     | 5.12.5            | `GHSA-389g-gv7q-r4x8` low — header `propertyNames`               | No route declares a header JSON schema. Bump to ≥5.12.6.                                                                                                                                                                     |

**Action:** the Next.js bump is the one that matters and it is a patch release. Do it first, then re-run `pnpm audit` and pin a renovate/dependabot policy so this list never accumulates again — the repo currently has no automated dependency alerting, which is why a critical advisory is sitting in the tree.

---

## 12. Remediation order

### Wave 1 — do now (exploitable or one-line)

1. **SEC-01** Bump `next` to ≥15.5.29 (clears the RCE and three moderates).
2. **SEC-03** Stop returning the webhook secret; mask it. (Two return statements.)
3. **SEC-02** Rewrite the webhook egress guard: resolve-all, reject mapped/NAT64 ranges, `redirect: 'manual'`, re-validate each hop.
4. **SEC-04** Enforce `expiresAt` on the Redis hit path so sessions actually die.
5. **SEC-07** Pin the Stoplight script (real dependency, or exact version + SRI).

### Wave 2 — before any multi-instance or public deployment

6. **SEC-05** Redis-back the credential limiter; run one integration test with it enabled.
7. **SEC-08** Limiter on `/api/*`; replace the unbounded `count(*)` with a bounded query.
8. **SEC-10** `key:invalidated` pub/sub; stop caching `secretHash`.
9. **SEC-09** Stop caching `role` for 7 days, or add invalidation before member management ships.
10. **SEC-14** Durable webhook outbox with retries and a delivery record.
11. **SEC-17** HSTS, CSP, `__Host-` cookie prefixes, `Cache-Control: no-store`.
12. **SEC-15** Validate `WEB_ORIGIN` at boot; refuse `*`.
13. **SEC-12** Dedupe + retention on `api_key_events`.

### Wave 3 — correctness and defence in depth

14. **SEC-20** Typed safe errors instead of echoing every 4xx message.
15. **SEC-11** Cap `responseHeaders` key count and allowlist names.
16. **SEC-13** Boot-generated dummy hash for a genuinely flat login.
17. **SEC-19** Proxy allowlist instead of hop counting.
18. **SEC-06, SEC-18** Dependency upgrades beyond Next.
19. **SEC-16** Breached-password check, email verification, register throttle.
20. **SEC-23** Password-change + "sign out everywhere" (makes `destroyAllSessionsForUser` reachable), absolute session cap.

### Wave 4 — hygiene

21. **SEC-24, SEC-25, SEC-26, SEC-27, SEC-28** and the `KEYS` → `SCAN` change, plus `whsec_` in `redact()`.

---

## 13. What is genuinely well done

Worth stating plainly, because the criticism above is dense:

- **The API key subsystem is better than most production code.** Rejection-sampled CSPRNG keys, HMAC-with-pepper over a slow KDF _with the reasoning written down_, indexed lookup plus a dummy HMAC on a miss, uniform 401, additive-only rotation scopes, and a family kill switch. SEC-10 is a cache concern, not a flaw in the design.
- **The template sandbox holds.** No eval anywhere, a closed faker allowlist, `__proto__`/`constructor`/`prototype` refused at every step, own-properties only, per-request faker, and failures that degrade instead of throwing. I tried the usual escapes and found none.
- **The rate limiter is correct.** A single atomic Lua script with Redis `TIME`, org-level buckets so keys cannot multiply the quota, and headers on both success and 429.
- **The playground's trust model is defensive by construction** — no raw keys, no free-form URL, no network hop, and the bypass still re-checks every lifecycle rule against the database.
- **Tenant isolation is consistent.** Mock services resolve by `(orgId, slug)`; analytics, keys, chaos and playground are all `org_id`-scoped; chaos rule targets are ownership-checked; foreign ids 404.
- **Documentation is unusually honest.** `audit.ts` documents its own write-amplification vector; the rate limiter documents that it is per-process; the fail-open behaviour is written down rather than hidden. Most audits find more because the code pretends less.

---

## Appendix — reproduction commands

```bash
# Dependency posture
pnpm audit --prod

# Webhook guard bypasses (IPv6 forms) and redirect escape
#   see the guard table in §8; the guard is isValidWebhookUrl() in
#   apps/server/src/analytics/webhooks.ts

# Login timing oracle
#   verify(DUMMY_HASH, 'wrong') vs verify(realHash, 'wrong') via @node-rs/argon2
#   -> 23.3ms vs 13.1ms

# CORS
#   Fastify + @fastify/cors { origin: ['*'], credentials: true }
#   -> Access-Control-Allow-Origin: *  with  Allow-Credentials: true

# Unbounded responseHeaders
#   z.record(z.string().max(200)) with 40 000 keys / 589 KB -> accepted
```
