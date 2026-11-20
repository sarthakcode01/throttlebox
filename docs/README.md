# Throttlebox Documentation

Throttlebox is a SaaS developer portal that serves **mock APIs** behind **API keys**, **tiered sliding-window rate limits**, **request analytics**, and **chaos engineering controls**. Developers build against realistic endpoints without waiting for a backend team.

## Index

| Doc                                        | What it covers                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| [OVERVIEW.md](./OVERVIEW.md)               | What the product is, who it's for, feature list, current status            |
| [ARCHITECTURE.md](./ARCHITECTURE.md)       | Monorepo layout, runtime components, request pipeline, caching and pub/sub |
| [GETTING_STARTED.md](./GETTING_STARTED.md) | Prerequisites, setup, scripts, environment variables, testing, CI          |
| [API_REFERENCE.md](./API_REFERENCE.md)     | Every HTTP endpoint: auth, keys, services, analytics, chaos, mock, health  |
| [DATABASE.md](./DATABASE.md)               | Schema, tables, enums, hypertable, continuous aggregate, migrations        |
| [SECURITY.md](./SECURITY.md)               | Auth, CSRF, key hashing, SSRF guard, template sandbox, known open issues   |
| [FEATURES.md](./FEATURES.md)               | Deep dives: rate limiter, mock engine, chaos engine, analytics, webhooks   |
| [ROADMAP.md](./ROADMAP.md)                 | Phase status (0–10), what's done and what remains                          |
| [PHASE_7_PLAN.md](./PHASE_7_PLAN.md)       | The Time-Travel Playground design and implementation plan                  |

## Pre-existing docs in the repo root

- `README.md` — quick start and feature explanations
- `API_DEVELOPER_PORTAL_PLAN.md` — original step-by-step build plan
- `PHASES.md` — phase breakdown, dependencies, milestones
- `API_KEY_MANAGEMENT_PLAN.md` — Phase 2 design
- `PROJECT_MISTAKES_AND_TECHNICAL_DEBT_AUDIT.md` — 2026-11-07 defect audit (Phases 0–5)
- `SECURITY_AUDIT_2026_11_16.md` — security audit (Phases 0–6)
- `NOVEMBER_2_2026_WORK_REPORT.md` — work report

The `docs/` files are a synthesized, code-verified description of the project as it stands (commit `0b564ea`, Phase 6 complete).
