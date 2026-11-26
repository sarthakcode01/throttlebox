# Roadmap & Status

Source of truth: `PHASES.md` plus the code itself. Status is stated as verified
against the working tree, not against commit hashes: this repository's history
was squashed, so older hashes no longer resolve.

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

The security items here have been **fixed** — see `SECURITY_AUDIT_2026_11_26.md`
§10 for each finding and its evidence. What remains:

1. **Phase 8 — testing & CI hardening.** CI already runs real Postgres and Redis
   service containers and `pnpm test` covers 33 suites, so this is narrower than
   the phase table implies. Still missing, verified by inspection: Playwright E2E
   (the dashboard and playground have no browser coverage), testcontainers (CI
   uses service containers instead), a coverage threshold (there is none), and a
   nightly k6 smoke test.

   **CI is currently red on the base commit**: `pnpm format:check` is repo-wide
   and 28 committed files are unformatted, so the job fails before typecheck,
   lint, build and test ever run. That is a formatting debt, not a code failure,
   and it hides every other result.

2. **Phase 9 — deployment.** No `Dockerfile` exists anywhere in the repo, and no
   hosting configuration. Everything above is local-only today.

3. **Phase 10 — portfolio polish.** Docs exist and are reasonably complete, but
   there are no ADRs, no postmortem, and no demo video.

4. **Stale docs.** `README.md` had claimed Phases 0–3 while this file claimed
   0–7, and `PHASES.md` marked Phase 7 as incomplete while marking Phases 2–6
   complete. Those are now reconciled; keep them in step as phases land.

5. Playground follow-ups: Monaco editor (currently a plain textarea), OpenAPI
   export from captured traffic (only Vitest and Postman ship today), and
   pagination beyond 200 requests in the UI.
