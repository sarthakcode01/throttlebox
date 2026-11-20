# Getting Started

## Prerequisites

- Node ≥ 22.13 (CI uses Node 24), pnpm 11 (`packageManager: pnpm@11.25.0`)
- Docker Desktop (for TimescaleDB + Redis)

## Setup

```bash
pnpm install
cp .env.example .env        # edit SESSION_SECRET and KEY_PEPPER
docker compose up -d        # postgres (timescaledb pg16) :5432, redis :6379
pnpm db:migrate             # applies drizzle/0000–0006
pnpm dev                    # API :3001, web :3000
```

Open http://localhost:3000, register, and create a key under **API keys**. A seeded **ecommerce** service exists for each new org:

```bash
curl -H "Authorization: Bearer sk_test_..." http://localhost:3001/mock/ecommerce/products/42
```

## Environment variables

Server config is validated by zod in `apps/server/src/config.ts`; invalid config aborts boot. The `.env` is loaded from the repo root.

| Variable                         | Default                 | Notes                                                         |
| -------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`                   | — (required)            | `postgres://postgres:postgres@localhost:5432/throttlebox`     |
| `REDIS_URL`                      | — (required)            | `redis://localhost:6379`                                      |
| `SESSION_SECRET`                 | — (required, ≥16 chars) |                                                               |
| `KEY_PEPPER`                     | — (required, ≥16 chars) | Must differ from `SESSION_SECRET`; `openssl rand -hex 32`     |
| `NODE_ENV`                       | `development`           | `development`/`test`/`production`                             |
| `PORT`                           | `3001`                  |                                                               |
| `COOKIE_DOMAIN`                  | `localhost`             |                                                               |
| `TRUST_PROXY_HOPS`               | `0`                     | Number of trusted reverse proxies                             |
| `AUTH_RATE_LIMIT_MAX`            | `20`                    | Credential attempts per IP per window                         |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `900`                   |                                                               |
| `SESSION_TTL_SECONDS`            | 604800 (7 days)         |                                                               |
| `WEB_ORIGIN`                     | `http://localhost:3000` | Read directly from `process.env` for CORS (not in zod schema) |
| `NEXT_PUBLIC_API_URL`            | `http://localhost:3001` | Web app → API base URL                                        |

## Scripts (root)

| Command                                         | Description                            |
| ----------------------------------------------- | -------------------------------------- |
| `pnpm dev`                                      | Both apps in parallel (turbo)          |
| `pnpm build` / `start`                          | Build / start                          |
| `pnpm typecheck`, `pnpm lint`, `pnpm test`      | Per-package via turbo                  |
| `pnpm format` / `format:check`                  | Prettier                               |
| `pnpm check`                                    | format:check + typecheck + lint + test |
| `pnpm db:up` / `db:down` / `db:logs`            | docker compose helpers                 |
| `pnpm db:generate` / `db:migrate` / `db:studio` | drizzle-kit                            |

## Testing

- Server tests: Vitest (`apps/server/tests/**/*.test.ts`), run against a **real Postgres and Redis** (no mocks) — start docker compose first.
- Suites cover auth, keys (format, generation, hardening, routes), mock (template, services, routes), rate limiter (boundaries, cache, org plan, middleware), analytics, chaos sampling/middleware. Phase 7 adds the playground runner, routes and export (including an end-to-end test that runs the generated Vitest file). `packages/shared` tests cover permissions, plans and the JSON diff.
- `apps/server/tests/perf/rate-limit.k6.js` is a k6 load script for limiter correctness/overhead.
- The web app has unit tests for the playground helpers only (`apps/web/tests`); Playwright E2E is planned (Phase 8).

## CI

`.github/workflows/ci.yml` (push/PR to `main`, ubuntu-24.04): spins up timescaledb + redis services, then install (frozen lockfile) → migrate → format check → typecheck → lint → build → test.

## Turborepo note

`AGENTS.md` instructs agents to read the installed turbo package's own `docs/README.md` before changing Turborepo config, since the version may differ from common knowledge.
