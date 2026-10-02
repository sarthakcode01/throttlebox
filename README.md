# Throttlebox

A SaaS developer portal that serves mock APIs — so developers can build against
realistic endpoints without waiting on a backend team.

Users sign up, generate API keys, and consume mock APIs under tiered rate limits,
with usage visualized on a dashboard.

## Status

Phases 0 and 1 are done: the monorepo, local infra, and custom authentication are working.
The full plan lives in this repo:

- [`API_DEVELOPER_PORTAL_PLAN.md`](./API_DEVELOPER_PORTAL_PLAN.md) — scope, stack, and step-by-step build process
- [`PHASES.md`](./PHASES.md) — phase breakdown, dependencies, and milestones

## Getting started

**Prerequisites:** Node 20+, pnpm 11+, Docker Desktop.

```bash
git clone https://github.com/sarthakcode01/throttlebox.git
cd throttlebox
pnpm install

cp .env.example .env     # then edit SESSION_SECRET
docker compose up -d     # TimescaleDB + Redis
pnpm db:migrate          # apply the Drizzle migration

pnpm dev                 # API on :3001, web on :3000
```

Open http://localhost:3000, create an account, and you'll land on a dashboard
showing your workspace, plan, and role.

### How auth works

No third-party auth provider. Passwords are hashed with **Argon2id**; sessions are
random 256-bit tokens stored **hashed** (SHA-256) in Postgres for audit and cached
in **Redis** for fast lookup, delivered as an `httpOnly` cookie with sliding
expiration. A readable CSRF cookie is echoed back in `X-CSRF-Token` on mutations.

```bash
# Register (creates a user + a personal org + a session)
curl -i -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"at-least-10-chars","name":"You"}'

# Inspect your session
curl http://localhost:3001/api/me -b cookies.txt
```

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

- API key generation, rotation, and revocation
- Sliding-window rate limiting via Redis Lua
- A mock API engine with templated responses and generated OpenAPI docs
- Request analytics with p50/p95/p99 latency
- Chaos engineering controls (latency, errors, dropped connections)
- Team workspaces with role-based access control

## License

MIT
