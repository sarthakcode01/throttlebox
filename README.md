# Throttlebox

A SaaS developer portal that serves mock APIs — so developers can build against
realistic endpoints without waiting on a backend team.

Users sign up, generate API keys, and consume mock APIs under tiered rate limits,
with usage visualized on a dashboard.

## Status

Early build. The full plan lives in this repo:

- [`API_DEVELOPER_PORTAL_PLAN.md`](./API_DEVELOPER_PORTAL_PLAN.md) — scope, stack, and step-by-step build process
- [`PHASES.md`](./PHASES.md) — phase breakdown, dependencies, and milestones

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ with TypeScript |
| API | Fastify |
| Frontend | Next.js (App Router) + TanStack Query + Recharts |
| Database | PostgreSQL + Drizzle ORM |
| Analytics | TimescaleDB |
| Cache / rate limiting | Redis |
| Auth | Clerk |
| Tests | Vitest + Supertest + Playwright |
| Deploy | Fly.io (API) + Vercel (frontend) |

## Planned features

- API key generation, rotation, and revocation
- Sliding-window rate limiting via Redis Lua
- A mock API engine with templated responses and generated OpenAPI docs
- Request analytics with p50/p95/p99 latency
- Chaos engineering controls (latency, errors, dropped connections)
- Team workspaces with role-based access control

## License

MIT
