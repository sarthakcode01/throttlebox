# API Developer Portal & Sandbox — Build Guide (Step-by-Step)

## Core Concept

A SaaS dashboard that provides mock data APIs (e.g., fake e-commerce backend, weather service) for developers to use in testing. Users sign up, generate API keys, and consume mock APIs under tiered rate limits with usage visualized on a React dashboard.

**Target Complexity: 8–8.5/10** (Senior-level portfolio piece)

---

## Final Scope (Trimmed for Shipping)

### Core (Must Build)

| Feature                                       | Difficulty | Portfolio Signal |
| --------------------------------------------- | :--------: | :--------------: |
| Key Generation & Management                   |    ⭐⭐    |     ⭐⭐⭐⭐     |
| Rate Limiting (sliding window, Redis)         |  ⭐⭐⭐⭐  |    ⭐⭐⭐⭐⭐    |
| API Key Security (Argon2, prefixes, rotation) |   ⭐⭐⭐   |    ⭐⭐⭐⭐⭐    |
| Analytics + TimescaleDB (p50/p95/p99)         |  ⭐⭐⭐⭐  |     ⭐⭐⭐⭐     |
| Subscription Tiers (middleware pipeline)      |   ⭐⭐⭐   |      ⭐⭐⭐      |
| Team Workspaces & RBAC (basic)                |   ⭐⭐⭐   |      ⭐⭐⭐      |

### Differentiators (Pick 2)

| Feature                         | Difficulty |   Portfolio Signal   |
| ------------------------------- | :--------: | :------------------: |
| Chaos Engineering Controls      |  ⭐⭐⭐⭐  |       ⭐⭐⭐⭐       |
| Time-Travel Playground          |  ⭐⭐⭐⭐  |       ⭐⭐⭐⭐       |
| Plugin System (QuickJS sandbox) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ (high risk) |
| Contract Testing (Pact + CI)    |  ⭐⭐⭐⭐  |        ⭐⭐⭐        |

### Optional (Only If Time Allows)

- API Versioning + Sunset headers
- Distributed Tracing (OpenTelemetry)
- Multi-Region Edge — **skip unless everything else is done**
- AI Mock Generation — **skip, dilutes systems story**

---

## Recommended Stack

| Layer                | Technology                                           |
| -------------------- | ---------------------------------------------------- |
| Runtime              | Node.js 20+ with TypeScript                          |
| API Server           | Fastify (or Hono)                                    |
| Frontend             | Next.js 14+ (App Router) + TanStack Query + Recharts |
| Primary DB           | PostgreSQL + Drizzle ORM                             |
| Analytics DB         | TimescaleDB (Postgres extension)                     |
| Cache/Rate Limit     | Redis (Upstash for prod, Docker for dev)             |
| Auth                 | Custom (Argon2id + server-side sessions in Redis)    |
| Sandbox (if plugins) | quickjs-emscripten                                   |
| Load Testing         | k6                                                   |
| Tests                | Vitest + Supertest + Playwright                      |
| Deploy               | Railway/Fly.io (API) + Vercel (frontend)             |
| CI/CD                | GitHub Actions                                       |

---

# STEP-BY-STEP BUILD PROCESS

## PHASE 0 — Project Setup & Tooling (Days 1–2)

**Step 0.1 — Initialize monorepo**

```bash
mkdir api-portal && cd api-portal
git init
pnpm init
pnpm add -D typescript turbo eslint prettier
mkdir apps/server apps/web packages/shared
```

**Step 0.2 — Configure TypeScript + ESLint + Prettier**

- Root `tsconfig.base.json` with strict mode, path aliases
- ESLint flat config, Prettier, husky pre-commit hook (lint + format)

**Step 0.3 — Docker Compose for local infra**

```yaml
# docker-compose.yml
services:
  postgres:
    image: timescale/timescaledb:latest-pg16
    ports: ['5432:5432']
    environment:
      POSTGRES_PASSWORD: dev
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
```

**Verify**: `docker compose up -d` → both services healthy.

**Step 0.4 — Fastify hello-world + Next.js hello-world**

- `apps/server`: Fastify with `GET /health` returning `{ ok: true }`
- `apps/web`: Next.js with a landing page
- Env validation with Zod (`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `COOKIE_DOMAIN`)

**Step 0.5 — GitHub Actions CI skeleton**

- On PR: install, typecheck, lint, test. Keep it green from day one.

✅ **Exit criteria**: `pnpm dev` runs both apps; CI green; DB + Redis containers up.

---

## PHASE 1 — Auth & Organizations (Days 3–5)

**Step 1.1 — Password auth + sessions**

- Argon2id password hashing (same primitive as API keys — reuse the module)
- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`
- Session = random 256-bit token stored hashed in Redis with a sliding TTL, delivered as an httpOnly, Secure, SameSite=Lax cookie
- CSRF: `SameSite=Lax` + an `X-CSRF-Token` double-submit token on all mutations
- **Skip email verification and password reset** — needs a mail provider, adds little to the portfolio story
- Protect `/dashboard/*`; public `/` and `/docs`

**Step 1.2 — Database schema: users & orgs**

```sql
-- via Drizzle migration
users     (id uuid pk, email text unique, password_hash text,
           name text, created_at, last_login_at)
-- case-insensitive uniqueness without the citext extension:
-- CREATE UNIQUE INDEX users_email_lower ON users (lower(email));
sessions  (id uuid pk, user_id fk, expires_at, created_at,
           ip text, user_agent text)   -- audit trail; Redis holds the hot path
orgs      (id uuid pk, name, owner_id fk users, plan text default 'free', created_at)
org_members (org_id, user_id, role text)  -- owner|admin|dev|viewer
```

**Step 1.3 — Session middleware on the API**

- Fastify decorator reads the cookie → looks up the hashed token in Redis → attaches `user` to the request
- No provider SDK in the request path; `requireAuth()` is ~10 lines
- Sliding TTL: active sessions extend; record `last_login_at` on new sign-ins

**Step 1.4 — Role middleware on the API**

```typescript
// requireRole('dev') → checks org_members.role against permission matrix
const PERMISSIONS = {
  owner: ['*'],
  admin: ['keys:*', 'members:invite', 'plugins:deploy'],
  dev: ['keys:create', 'keys:rotate', 'plugins:deploy'],
  viewer: ['keys:read'],
};
```

✅ **Exit criteria**: Sign up → org auto-created → role visible in DB → `GET /me` returns org + role.

---

## PHASE 2 — API Key Management (Days 6–9)

**Step 2.1 — Key model**

```sql
api_keys (
  id uuid pk,
  org_id fk,
  name text,                 -- "staging-backend"
  prefix text,               -- 'sk_test_ab12' (first 12 chars, stored)
  hash text,                 -- Argon2id of full key
  last4 text,
  scopes jsonb,              -- ['mock:read', 'mock:write']
  env text default 'test',   -- test | live
  status text default 'active', -- active | revoked
  expires_at timestamptz null,
  created_at, revoked_at, last_used_at
)
```

**Step 2.2 — Key generation (server-side only)**

```typescript
function generateKey(env: 'test' | 'live') {
  const secret = base62(crypto.randomBytes(24)); // ~32 chars
  const key = `sk_${env}_${secret}`;
  return {
    key, // shown ONCE
    prefix: key.slice(0, 12),
    hash: await argon2id(key),
    last4: key.slice(-4),
  };
}
```

**Rules**: raw key returned exactly once in the create response, never logged, never stored.

**Step 2.3 — Key lookup path (the hot path)**

- Cache `prefix → key row` in Redis with 60s TTL
- On request: `Authorization: Bearer sk_...` → split prefix → cache/DB lookup → Argon2 verify → attach `key_id`, `org_id` to request
- Update `last_used_at` asynchronously (queue, not inline)

**Step 2.4 — Rotation & revocation**

- Rotate: create new key, old key stays valid with `expires_at = now() + 24h`
- Revoke: set `status='revoked'`, purge Redis cache immediately
- Enforce in lookup path: check `status` AND `expires_at`

**Step 2.5 — Frontend: Keys page**

- List keys (name, prefix…last4, env, status, last used)
- Create modal → one-time reveal with copy button + warning
- Rotate/revoke with confirm dialog

✅ **Exit criteria**: Create key → curl a protected mock endpoint with it → revoke → 401. Rotation overlap works.

---

## PHASE 3 — Mock API Engine (Days 10–14)

**Step 3.1 — Mock service model**

```sql
mock_services (id, org_id, name, slug, base_path)          -- e.g. /mock/org1/ecommerce
mock_routes   (id, service_id, method, path, status_code,
               response_template jsonb, latency_ms int default 0,
               weighted_responses jsonb null)               -- for chaos later
```

- `path` supports params: `/products/:id`
- `response_template` supports template vars: `{ "id": "{{params.id}}", "name": "{{faker.commerce.product}}" }`

**Step 3.2 — Router**

- Register routes into a radix tree (use `find-my-way`, Fastify's router)
- Match incoming `method + path` against org's routes
- Render template: replace `{{params.*}}`, `{{query.*}}`, `{{faker.*}}` (faker.js seedable per-request for reproducibility)

**Step 3.3 — Seed a flagship service**

- Build one polished "E-commerce API" (products, orders, customers) as the default service every new org gets
- This is what demo reviewers will play with — make the data realistic

**Step 3.4 — CRUD UI + docs generation**

- UI to create/edit routes with live preview
- Auto-generate OpenAPI 3.1 spec from route definitions → serve at `/docs/openapi.json` → render with Stoplight Elements

✅ **Exit criteria**: `curl -H "Authorization: Bearer sk_..." /mock/{org}/ecommerce/products/42` returns templated JSON. OpenAPI docs render.

---

## PHASE 4 — Rate Limiting (Days 15–20) ⭐ Core Feature

**Step 4.1 — Tier model**

```sql
plans (id, name, requests_per_window int, window_seconds int, burst_allowance int)
-- free:    100/3600s, burst 1.1
-- pro:    5000/3600s, burst 1.2
```

**Step 4.2 — Sliding window limiter (Redis Lua)**

```lua
-- KEYS[1]=rate:{key_id}, ARGV: now, window_ms, limit
-- ZREMRANGEBYSCORE old entries, ZCARD count,
-- if count < limit: ZADD now, return allowed + remaining
-- else return denied + oldest_score + window (for Retry-After)
```

Lua = atomic; never do INCR-then-check in two round trips.

**Step 4.3 — Middleware pipeline (order matters)**

```
auth(key) → org resolution → tier lookup (cached 30s) → rate limit → quota check → chaos check → route handler
```

**Step 4.4 — Proper 429 semantics**

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1725700000
Retry-After: 42
```

Success responses also carry the three `X-RateLimit-*` headers (GitHub/Stripe behavior).

**Step 4.5 — Tier upgrades in real time**

- On plan change: publish `plan:changed` to Redis pub/sub → all instances invalidate local tier cache → next request uses new limit. No restart.

**Step 4.6 — Prove it with a load test**

```javascript
// k6: ramp to 200 VUs, fire at one key, assert:
// - exactly `limit` 200s
// - 429s have correct headers
// - limiter adds < 5ms p95 overhead
```

Save the k6 output graph → goes in your README.

✅ **Exit criteria**: k6 run shows exact limit enforcement, correct headers, p95 overhead < 5ms. Upgrade plan → limit changes without restart.

---

## PHASE 5 — Analytics & Logging (Days 21–27)

**Step 5.1 — Request log table (Timescale hypertable)**

```sql
CREATE TABLE request_logs (
  time timestamptz NOT NULL,
  key_id uuid, org_id uuid, service_id uuid,
  method text, path text, status_code int,
  latency_ms int, rate_limited bool,
  trace_id text
);
SELECT create_hypertable('request_logs', 'time');
CREATE INDEX ON request_logs (key_id, time DESC);
CREATE INDEX ON request_logs (org_id, time DESC);
```

**Step 5.2 — Non-blocking ingestion path**

```
request → handler → respond immediately
              └→ push log entry to in-memory buffer → batch INSERT every 500ms / 100 rows
```

Logging must never add latency to the mocked response. Buffer survives via BullMQ if you want durability.

**Step 5.3 — Continuous aggregates (the indexing story)**

```sql
CREATE MATERIALIZED VIEW usage_hourly WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket, key_id,
       count(*) requests,
       count(*) FILTER (WHERE status_code >= 400) errors,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) p95
FROM request_logs GROUP BY bucket, key_id;
```

Dashboard queries hit this view, never raw logs. **Demo point**: show query plan before/after the index at 10M rows.

**Step 5.4 — Analytics API**

- `GET /analytics/usage?range=7d` → per-day per-key requests
- `GET /analytics/latency?range=24h` → p50/p95/p99 series
- `GET /analytics/errors?range=7d` → 4xx vs 5xx breakdown

**Step 5.5 — Dashboard charts**

- Recharts: usage area chart, latency multi-line (p50/p95/p99), status-code stacked bars, per-key table
- TanStack Query with 30s refetch; no premature WebSockets

**Step 5.6 — Quota webhooks**

- BullMQ job checks usage hourly → at 80% and 100% of quota, POST signed webhook (`HMAC-SHA256` in `X-Signature` header) to user's URL. Retries with exponential backoff, dead-letter queue.

✅ **Exit criteria**: Generate traffic → charts populate from aggregates; webhook fires at 80%; p95 stays flat at 1M logged rows.

---

## PHASE 6 — Chaos Engineering Controls (Days 28–32) 🎯 Differentiator #1

**Step 6.1 — Chaos config per key**

```json
// stored in Redis, editable in dashboard
{
  "latency": { "type": "normal", "mean": 200, "stddev": 50 },
  "errors": { "rate_5xx": 0.05, "rate_429": 0.01 },
  "partition": { "drop_rate": 0.0 }
}
```

**Step 6.2 — Chaos middleware (before route handler)**

```typescript
// 1. latency: await sleep(sample(dist))
// 2. errors: if (rand < rate_5xx) throw 500 with realistic body
// 3. partition: if (rand < drop_rate) destroy socket (real connection reset)
```

**Step 6.3 — Dashboard toggles**

- Sliders for latency μ/σ, error rates, drop rate — changes apply on next request (Redis read-through, 5s cache)

**Step 6.4 — "Test your resilience" demo page**

- Built-in script that fires 100 requests against your own mock with chaos on, renders a latency histogram + error breakdown
- This makes the chaos feature _self-demonstrating_ in interviews

✅ **Exit criteria**: Toggle 5% error rate → demo page shows ~5 failures in 100 requests with correct distribution.

---

## PHASE 7 — Time-Travel Playground (Days 33–39) 🎯 Differentiator #2

**Step 7.1 — Full request/response capture**

```sql
playground_sessions (id, org_id, created_at)
playground_requests (id, session_id, method, url, headers jsonb,
                    body text, response_status int, response_headers jsonb,
                    response_body text, duration_ms, created_at)
```

**Step 7.2 — In-app request runner**

- Code editor (Monaco) for body, method/URL/headers form, "Send" → executes through the same pipeline as external calls (rate limits apply — good)

**Step 7.3 — History & replay**

- Session timeline of every request
- Click any past request → "Replay" re-executes verbatim; "Fork" opens it pre-filled for editing

**Step 7.4 — Response diff**

- Select two runs of the same request → deep-diff JSON (use `json-diff`), render side-by-side with added/removed/changed highlighted

**Step 7.5 — Export as test (the senior touch)**

- "Generate Vitest test" → static analysis of response shape → emits a `.test.ts` snapshot + schema assertion file the user can download
- Also export collection as OpenAPI or Postman collection JSON

✅ **Exit criteria**: Send request → modify chaos → replay → see diff → export runnable Vitest file that passes locally.

---

## PHASE 8 — Testing & CI Hardening (Days 40–44)

**Step 8.1 — Unit tests (Vitest)**

- Rate limiter: boundary conditions (limit-1, limit, concurrent bursts, window expiry)
- Template renderer: params/query/faker substitution
- Key auth: expired, revoked, wrong prefix, cache invalidation

**Step 8.2 — Integration tests (Supertest + test DB)**

- Full pipeline: create key → hit mock → hit limit → 429 headers → upgrade plan → succeeds
- Use real Redis (testcontainers), never mock the limiter

**Step 8.3 — E2E (Playwright)**

- Signup → create key → see it once → charts populate → chaos toggle works

**Step 8.4 — CI pipeline (GitHub Actions)**

- PR: typecheck → lint → unit → integration (services via containers) → build
- Main: deploy on green; Nightly: k6 smoke test against staging

✅ **Exit criteria**: `>80%` coverage on limiter/auth/template modules; red test = blocked merge.

---

## PHASE 9 — Deployment (Days 45–48)

**Step 9.1 — API on Railway or Fly.io**

- Dockerfile (multi-stage, non-root user, healthcheck `/health`)
- Fly.io preferred if you want multi-region later (`fly deploy --region yyz,iad,syd`)

**Step 9.2 — Managed data layer**

- Upstash Redis (global option = free multi-region story)
- Neon/Supabase Postgres with TimescaleDB enabled

**Step 9.3 — Frontend on Vercel**

- Env vars → API URL, `SESSION_SECRET`, `COOKIE_DOMAIN`; CORS locked to the frontend origin with credentials enabled

**Step 9.4 — Production hardening**

- Rate limit _the dashboard API itself_ (separate limiter, per-user)
- Structured logs (pino) + error tracking (Sentry free tier)
- Secret scanning in CI (never commit a key that starts with `sk_`)

**Step 9.5 — Seed demo org**

- Public demo account with pre-made keys + realistic 30 days of generated usage data, so the dashboard looks alive on first visit

✅ **Exit criteria**: Live URL works end-to-end from a clean browser; demo org dashboard is populated.

---

## PHASE 10 — Portfolio Polish (Days 49–56)

**Step 10.1 — README that sells**

- 30-second elevator pitch + GIF of the killer feature (chaos toggle or playground diff)
- Mermaid architecture diagram (edge → API → Redis/PG/Timescale pipeline)
- k6 results table, link to ADRs

**Step 10.2 — ADRs (`/docs/adr/`)**

- `001-sliding-window-vs-token-bucket.md`
- `002-argon2id-for-api-keys.md`
- `003-async-log-ingestion.md`
- `004-timescale-aggregates.md`
  Each: context → options → decision → tradeoffs.

**Step 10.3 — One postmortem**

- `docs/postmortem-log-pipeline.md`: the bug where batch inserts blocked under load, how you found it, the fix. Interviewers _love_ this.

**Step 10.4 — 3-minute demo video (Loom)**

- Script: signup (10s) → key reveal (15s) → first mock call (15s) → charts (30s) → rate limit 429 demo (30s) → chaos toggle (45s) → playground diff + test export (45s)

**Step 10.5 — Optional blog post**

- "Building a sliding-window rate limiter in Redis Lua" — highest-ROI topic

✅ **Exit criteria**: A stranger can understand, run (`docker compose up`), and evaluate the project in under 10 minutes.

---

## Timeline Summary

| Phase              | Days  | Cumulative |
| ------------------ | :---: | :--------: |
| 0 — Setup          |  1–2  |     2      |
| 1 — Auth & Orgs    |  3–5  |     5      |
| 2 — API Keys       |  6–9  |     9      |
| 3 — Mock Engine    | 10–14 |     14     |
| 4 — Rate Limiting  | 15–20 |     20     |
| 5 — Analytics      | 21–27 |     27     |
| 6 — Chaos Controls | 28–32 |     32     |
| 7 — Playground     | 33–39 |     39     |
| 8 — Testing & CI   | 40–44 |     44     |
| 9 — Deployment     | 45–48 |     48     |
| 10 — Polish        | 49–56 |     56     |

**~8 weeks full-time, ~14–16 weeks at 15 hrs/week.**

**Minimum viable portfolio** = Phases 0–5 + 9 + 10 (shippable at day ~35). Phases 6–7 are the differentiators that push it to 8.5.

---

## Difficulty Legend

| Rating     | Meaning                                   |
| ---------- | ----------------------------------------- |
| ⭐         | Trivial (hours)                           |
| ⭐⭐       | Straightforward (1–2 days)                |
| ⭐⭐⭐     | Moderate (3–5 days, design decisions)     |
| ⭐⭐⭐⭐   | Hard (1–2 weeks, debugging depth)         |
| ⭐⭐⭐⭐⭐ | Expert (2+ weeks, research, failure risk) |

---

## What to Explicitly Skip

| Skip                                | Reason                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Email verification / password reset | Needs a mail provider; not worth the time for a demo                             |
| Custom session mechanics            | **Doing this** — see Phase 1. Only skip _email delivery_, not the session system |
| Stripe billing                      | Fintech complexity ≠ platform complexity                                         |
| Kubernetes                          | Managed services; DevOps ≠ product engineering                                   |
| AI mock generation                  | Dilutes the systems-engineering story                                            |
| Multi-region                        | Fragile on free tiers; only after everything else                                |
| WebSockets everywhere               | Polling/SSE is sufficient                                                        |
| GraphQL                             | REST + OpenAPI covers 95%                                                        |

---

_Updated: trimmed scope, added step-by-step build process with exit criteria per phase._
