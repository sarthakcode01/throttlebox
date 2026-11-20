# Overview

## What it is

Throttlebox is an API developer portal. A user signs up, gets a personal organization, creates API keys, defines (or uses a seeded) **mock service**, and calls it with `Authorization: Bearer sk_...`. Every call passes through rate limiting and optional chaos injection, and is recorded for analytics shown on a dashboard.

## Core capabilities

| Capability        | Summary                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth & orgs**   | Custom email/password auth (Argon2id), Redis-cached sessions in httpOnly cookies, CSRF double-submit, roles `owner/admin/dev/viewer`              |
| **API keys**      | `sk_{env}_{publicId}_{secret}`, HMAC-SHA-256 + server pepper, one-time reveal, rotation with grace window, family revocation, scopes, audit trail |
| **Mock engine**   | Per-org services with routes; JSON templates with `{{params.*}}`, `{{query.*}}`, `{{body.*}}`, seeded `{{faker.*}}`; OpenAPI 3.1 generation       |
| **Rate limiting** | Atomic Redis Lua sliding window, per organization, by plan (`free` 100/h, `pro` 5000/h ×1.2 burst), `X-RateLimit-*` + `Retry-After`               |
| **Analytics**     | Batched non-blocking ingestion into a TimescaleDB hypertable, hourly continuous aggregate, p50/p95/p99, error breakdown, request log browser      |
| **Webhooks**      | HMAC-signed quota alerts at 80% and 100% of plan, SSRF-guarded URLs                                                                               |
| **Chaos**         | Per-org/service/key rules: Gaussian/uniform/fixed latency, 5xx/429 injection, simulated network partition (socket destroy), benchmark studio      |

## Status (per `PHASES.md` and git log)

Phases 0–7 are complete. Phase 8 (testing/CI consolidation), 9 (deploy), 10 (polish) are not started. Note the root `README.md` still says "Phases 0–3 done" and lists rate limiting/analytics/chaos as planned — it is out of date; the code contains all of them.

## Tech stack

| Layer           | Technology                                                               |
| --------------- | ------------------------------------------------------------------------ |
| Runtime         | Node ≥ 22.13, TypeScript (ESM)                                           |
| API             | Fastify 5, zod, `find-my-way` (mock routing), pino                       |
| Web             | Next.js 15 (App Router), React 19, TanStack Query, hand-built SVG charts |
| DB              | PostgreSQL 16 + TimescaleDB, Drizzle ORM / drizzle-kit                   |
| Cache / limiter | Redis 7 (ioredis), Lua scripting, pub/sub                                |
| Passwords       | `@node-rs/argon2` (Argon2id)                                             |
| Fake data       | `@faker-js/faker` (closed allowlist)                                     |
| Tooling         | pnpm 11 workspaces, Turborepo, ESLint, Prettier, Vitest, Supertest, k6   |

## Tenancy model

- A **user** has memberships in **orgs**; registration creates a personal org with role `owner`.
- The **API key** is the tenant boundary for public mock traffic: a key resolves to `orgId`, and services are looked up by `(orgId, slug)`. The URL never carries the org.
- The dashboard uses the session's `orgId`/`role`.
