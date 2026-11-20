# Roadmap & Status

Source of truth: `PHASES.md` plus git history (latest commit `0b564ea` — Phase 6).

| Phase | Name                                                                            | Status          |
| ----- | ------------------------------------------------------------------------------- | --------------- |
| 0     | Foundation (monorepo, docker, CI)                                               | ✅              |
| 1     | Auth & Organizations                                                            | ✅              |
| 2     | API Key Management                                                              | ✅ (2026-10-20) |
| 3     | Mock API Engine                                                                 | ✅ (2026-10-21) |
| 4     | Rate Limiting (Redis Lua)                                                       | ✅              |
| 5     | Analytics & TimescaleDB                                                         | ✅ (2026-11-02) |
| 6     | Chaos Engineering Controls                                                      | ✅ (2026-11-14) |
| 7     | Time-Travel Playground (capture, replay, diff, export)                          | ✅ (2026-11-20) |
| 8     | Testing & CI hardening (testcontainers, Playwright, coverage gates, nightly k6) | ⬜              |
| 9     | Deployment (Dockerfile, Fly.io/Vercel, Sentry, CORS lockdown, demo org)         | ⬜              |
| 10    | Portfolio polish (README, ADRs, postmortem, demo video)                         | ⬜              |

## Suggested next work

1. **Fix stale docs** — root `README.md` says Phases 0–3 only; update status and feature lists.
2. **Close critical security items** from `SECURITY_AUDIT_2026_11_16.md`: SSRF-proof webhook egress (resolve + pin IP, no redirects), stop returning webhook secrets after creation.
3. **High-value hardening**: shared (Redis-backed) auth limiter, a limiter on the dashboard `/api/*` incl. chaos benchmark, key-cache pub/sub invalidation, durable webhook delivery, move latency/error/overview queries onto the continuous aggregate.
4. **Phase 8** (Playwright E2E for the dashboard including the playground; the web app only has unit tests for pure helpers) and **Phase 9** Dockerfile/deploy (no Dockerfile exists yet).
5. Migration housekeeping: add a drizzle snapshot for 0006 (generate currently re-emits chaos_rules).
6. Playground follow-ups: Monaco editor, OpenAPI export from captured traffic, pagination beyond 200 requests in the UI.
