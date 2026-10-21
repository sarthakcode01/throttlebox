# Throttlebox

A SaaS developer portal that serves mock APIs — so developers can build against
realistic endpoints without waiting on a backend team.

Users sign up, generate API keys, and consume mock APIs under tiered rate limits,
with usage visualized on a dashboard.

## Status

Phases 0–2 are done: the monorepo, local infra, custom authentication, and API
key management are working. The full plan lives in this repo:

- [`API_DEVELOPER_PORTAL_PLAN.md`](./API_DEVELOPER_PORTAL_PLAN.md) — scope, stack, and step-by-step build process
- [`PHASES.md`](./PHASES.md) — phase breakdown, dependencies, and milestones
- [`API_KEY_MANAGEMENT_PLAN.md`](./API_KEY_MANAGEMENT_PLAN.md) — the Phase 2 design, in detail

## Getting started

**Prerequisites:** Node 20+, pnpm 11+, Docker Desktop.

```bash
git clone https://github.com/sarthakcode01/throttlebox.git
cd throttlebox
pnpm install

cp .env.example .env     # then edit SESSION_SECRET and KEY_PEPPER
docker compose up -d     # TimescaleDB + Redis
pnpm db:migrate          # apply the Drizzle migration

pnpm dev                 # API on :3001, web on :3000
```

Open http://localhost:3000, create an account, and you'll land on a dashboard
showing your workspace, plan, and role. From there, **API keys** creates your
first key.

> `KEY_PEPPER` must differ from `SESSION_SECRET` — the server refuses to boot
> if they match. Generate one with `openssl rand -hex 32`.

### How auth works

No third-party auth provider. Passwords are hashed with **Argon2id**; sessions are
random 256-bit tokens stored **hashed** (SHA-256) in Postgres for audit and cached
in **Redis** for fast lookup, delivered as an `httpOnly` cookie with sliding
expiration.

CSRF uses the **double-submit** pattern: a second, readable cookie carries a
random token that the client echoes back in `X-CSRF-Token` on every mutation,
and the server compares the two in constant time. A cross-site page can cause
the browser to send the cookies, but it cannot read the token, so it cannot
produce a matching header. Requests that carry an `Authorization` header are
exempt — those are authenticated by a token a browser never attaches on its own.

Login and registration are **rate limited** per IP (20 attempts / 15 minutes by
default) so the Argon2id verification cannot be used for credential stuffing.
Expired session rows are swept by a background janitor — Redis is only a cache,
so Postgres is the durable copy and would otherwise grow without bound.

`X-Forwarded-For` is **ignored** unless `TRUST_PROXY_HOPS` is set, because the
API key audit trail records the client address and a spoofed header would let
anyone write false evidence into it.

```bash
# Register (creates a user + a personal org + a session)
curl -i -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"at-least-10-chars","name":"You"}'

# Inspect your session
curl http://localhost:3001/api/me -b cookies.txt
```

### How API keys work

A key is `sk_{env}_{publicId}_{secret}` — a 12-character lookup handle and a
32-character secret, both base62 from `crypto.randomBytes`.

| Concern         | Approach                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Storage**     | Only `HMAC-SHA-256(pepper, publicId:secret)` is stored, plus a display prefix and last-4. The raw key is never persisted.       |
| **Reveal**      | The raw key is returned exactly once, at creation and at rotation. There is no endpoint that can retrieve it again.             |
| **Pepper**      | Lives in `KEY_PEPPER` in the environment, never in the database. A stolen dump yields hashes an attacker cannot verify against. |
| **Lookup**      | The `publicId` is an indexed column, so verification is one indexed query — no scan over hashed rows.                           |
| **Comparison**  | `timingSafeEqual`, with a dummy HMAC on a miss so the timing profile stays flat.                                                |
| **Rotation**    | The old key keeps working for a grace window (24h) so a deploy can swap keys without downtime.                                  |
| **Kill switch** | Keys belong to a family. Revoking a family kills every key in the rotation chain at once.                                       |
| **Scopes**      | `mock:read`, `mock:write`, `chaos:write`, `keys:read`. An empty scope list means `mock:read` — never "all".                     |
| **Redaction**   | Keys are scrubbed from logs and error bodies; the regex is the safety net, not the primary defence.                             |

Why not Argon2id for keys? The threat model is different from passwords. A
password is low entropy, so a slow KDF is the point. A key carries 192 bits of
CSPRNG output — there is nothing to brute force — so a slow hash buys nothing
and costs 50–100ms on _every API request_. OWASP's guidance agrees: slow KDF
for low-entropy secrets, fast hash or HMAC for high-entropy tokens.

```bash
# Create a key (needs a session cookie)
curl -X POST http://localhost:3001/api/keys -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"name":"staging-backend","env":"live"}'

# List keys — masked, never the secret
curl http://localhost:3001/api/keys -b cookies.txt

# Rotate: the new key is returned once, the old one works for 24h
curl -X POST http://localhost:3001/api/keys/<id>/rotate -b cookies.txt \
  -H "Content-Type: application/json" -d '{"graceHours":24}'

# Revoke — immediate and authoritative
curl -X POST http://localhost:3001/api/keys/<id>/revoke -b cookies.txt
```

The `Idempotency-Key` header is supported on create. A repeated token is
rejected with a `409` rather than minting a second key — the original cannot
be replayed, because it was only ever shown once.

### Scripts

| Command           | Description                      |
| ----------------- | -------------------------------- |
| `pnpm dev`        | Run both apps in parallel        |
| `pnpm build`      | Build all packages               |
| `pnpm typecheck`  | Typecheck everything             |
| `pnpm lint`       | ESLint                           |
| `pnpm test`       | Vitest suites                    |
| `pnpm check`      | Format + typecheck + lint + test |
| `pnpm db:migrate` | Apply migrations                 |
| `pnpm db:studio`  | Browse the database              |

### Health probes

| Endpoint        | Meaning                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health`       | Liveness. The process is up. Does not touch the database or Redis, so a dependency blip cannot make an orchestrator kill a healthy instance. |
| `/health/ready` | Readiness. Checks that Postgres and Redis are reachable. Returns 503 when either is down, so traffic is routed away.                         |

## Architecture notes

- **Separate API boundary.** Next.js is a pure client; all data flows through the
  Fastify service, which is what developers hit with `curl` and a bearer token.
- **Two schemas, one database.** Transactional tables live in `public`; TimescaleDB
  hypertables and continuous aggregates will live in `_timescale` (Phase 5).
- **Redis is a cache, not the source of truth.** Sessions and rate-limit counters
  live there for speed; Postgres holds the durable record.

## Stack

| Layer                 | Technology                                       |
| --------------------- | ------------------------------------------------ |
| Runtime               | Node.js 20+ with TypeScript                      |
| API                   | Fastify                                          |
| Frontend              | Next.js (App Router) + TanStack Query + Recharts |
| Database              | PostgreSQL + Drizzle ORM                         |
| Analytics             | TimescaleDB                                      |
| Cache / rate limiting | Redis                                            |
| Auth                  | Custom — Argon2id + Redis-backed sessions        |
| Tests                 | Vitest + Supertest + Playwright                  |
| Deploy                | Fly.io (API) + Vercel (frontend)                 |

## Planned features

- A mock API engine with templated responses and generated OpenAPI docs
- Sliding-window rate limiting via Redis Lua
- Request analytics with p50/p95/p99 latency
- Chaos engineering controls (latency, errors, dropped connections)

## Done so far

- **Phase 0** — monorepo, local infra, CI
- **Phase 1** — custom auth (Argon2id + Redis sessions + CSRF), orgs, RBAC
- **Phase 2** — API key management: generation, one-time reveal, rotation with
  a grace window, family revocation, scopes, audit trail, and a dashboard

## License

MIT
